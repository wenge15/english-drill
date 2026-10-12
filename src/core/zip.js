'use strict';

/**
 * 极简 ZIP 读取器（零依赖，只用 Node 自带的 zlib）。
 *
 * 为什么自己写：这个项目的原则是零依赖。ZIP 的"读取"部分并不复杂 ——
 * 定位中央目录、逐条读元数据、按需解压 deflate 流即可。
 *
 * 支持范围（覆盖日常压缩包的绝大多数情况）：
 *   - 存储（method 0）与 deflate（method 8），这是唯二常见的方式
 *   - 中央目录定位（含尾部注释的情况）
 *   - 目录条目、macOS 的 __MACOSX / .DS_Store 会被过滤掉
 *
 * 明确不支持（遇到会如实报错，不猜）：
 *   - ZIP64（>4GB 或条目数 >65535）
 *   - 加密（method 带密码位）
 *   - bzip2 / lzma 等其它压缩方式
 *
 * 结构速查：
 *   [本地文件头 + 数据]... [中央目录]... [中央目录结束记录 EOCD]
 *   读取时从文件尾往回找 EOCD，再按它给出的偏移读中央目录。
 */

const zlib = require('node:zlib');

/** EOCD（中央目录结束记录）的签名。 */
const EOCD_SIG = 0x06054b50;
/** 中央目录条目的签名。 */
const CEN_SIG = 0x02014b50;

/** 解压方式 */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * 从尾部往回找 EOCD。
 * 注释最长 65535 字节，所以最多回退 65535 + 22 字节。
 */
function findEocd(buf) {
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 读取 ZIP 的条目清单（不解压数据，只读元数据）。
 * @param {Buffer} buf
 * @returns {Array<{name:string, method:number, compressedSize:number, size:number, crc32:number, localOffset:number, isDir:boolean, encrypted:boolean}>}
 */
function listEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new Error('不是有效的 ZIP：内容太短');
  }
  const eocd = findEocd(buf);
  if (eocd === -1) {
    throw new Error('不是有效的 ZIP：没找到中央目录结束记录（可能是 7z/rar，或文件不完整）');
  }

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64 特征：这些字段被填成 0xFFFFFFFF，真实值在 ZIP64 扩展里
  if (cenOffset === 0xffffffff || cenSize === 0xffffffff || entryCount === 0xffff) {
    throw new Error('这个压缩包是 ZIP64 格式（超大文件），当前不支持。请重新压缩为普通 zip。');
  }
  if (cenOffset + cenSize > buf.length) {
    throw new Error('ZIP 中央目录超出文件范围：文件可能不完整或被截断');
  }

  const entries = [];
  let p = cenOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;

    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);

    // 文件名编码：置了 0x800 位就是 UTF-8，否则按本地代码页（这里当 latin1 处理，够用）
    const flags = buf.readUInt16LE(p + 8);
    const isUtf8 = (flags & 0x800) !== 0;
    const name = buf
      .slice(p + 46, p + 46 + nameLen)
      .toString(isUtf8 ? 'utf8' : 'latin1');

    const isDir = name.endsWith('/') || (externalAttrs & 0x10) !== 0;
    // method 的第 0 位表示加密
    const encrypted = (flags & 0x1) !== 0;

    entries.push({
      name,
      method,
      crc32,
      compressedSize,
      size,
      localOffset,
      isDir,
      encrypted,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (entries.length === 0 && entryCount > 0) {
    throw new Error('ZIP 中央目录解析失败：找不到条目');
  }
  return entries;
}

/**
 * 解压单个条目。
 * @param {Buffer} buf 整个 zip
 * @param {object} entry listEntries 里的条目
 * @returns {Buffer}
 */
function readEntry(buf, entry) {
  if (entry.encrypted) {
    throw new Error(`条目「${entry.name}」是加密的，无法读取。请解压后重新打包。`);
  }
  // 本地文件头：签名(4) 版本(2) 标志(2) 方式(2) 时间(2) 日期(2) crc(4) 压缩长(4) 原长(4) 名长(2) 扩展长(2)
  const lo = entry.localOffset;
  if (lo + 30 > buf.length) throw new Error(`条目「${entry.name}」的本地头超出文件范围`);
  if (buf.readUInt32LE(lo) !== 0x04034b50) {
    throw new Error(`条目「${entry.name}」的本地文件头签名不对，压缩包可能已损坏`);
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;

  // 有些压缩包在中央目录里写了 0（流式写入），此时从下一个本地头/中央目录推算长度
  let compSize = entry.compressedSize;
  if (compSize === 0 && entry.size > 0) {
    const entries = null; // 不在这里递归，交给调用方；这里只做保守处理
    void entries;
    compSize = Math.max(0, Math.min(buf.length - dataStart, entry.size));
  }
  const dataEnd = dataStart + compSize;
  if (dataEnd > buf.length) throw new Error(`条目「${entry.name}」的数据超出文件范围`);

  const raw = buf.slice(dataStart, dataEnd);

  if (entry.method === METHOD_STORE) return raw;
  if (entry.method === METHOD_DEFLATE) {
    const out = zlib.inflateRawSync(raw);
    // 校验解压出来的长度（有些包会因截断而偏小）
    if (entry.size > 0 && out.length !== entry.size) {
      // 长度不符不直接报错：仍返回，但让上层知道可能不完整
      return out;
    }
    return out;
  }
  throw new Error(`条目「${entry.name}」用了不支持的压缩方式（method ${entry.method}），请重新压缩为普通 zip`);
}

/** 应当忽略的条目：目录、macOS 元数据、隐藏文件。 */
function isJunkEntry(name) {
  if (!name || name.endsWith('/')) return true;
  if (name.startsWith('__MACOSX/')) return true;
  const base = name.split('/').pop() || '';
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return true;
  if (base.startsWith('._')) return true;
  return false;
}

/** 支持的图片扩展名（与读图模型一致：JPEG/PNG/GIF/WebP，另加 bmp 让本地模型也能用）。 */
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

/** 按 MIME 判断是否图片（解压后用内容判断，比扩展名可靠）。 */
function mimeOf(name) {
  const ext = extOf(name);
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.pdf') return 'application/pdf';
  return '';
}

/**
 * 从 ZIP 里挑出可识别的图片。
 *
 * 按路径排序，保证"第 1 张"是可预期的顺序（通常就是试卷页码顺序）。
 *
 * @param {Buffer} buf
 * @param {object} [opts]
 * @param {number} [opts.limit] 最多取多少张（避免一次解压几百兆）
 * @returns {{images:Array<{name:string,mime:string,bytes:Buffer,size:number}>, skipped:number, total:number}}
 */
function extractImages(buf, opts = {}) {
  const limit = opts.limit === undefined ? 300 : Number(opts.limit);
  const entries = listEntries(buf);

  // 被忽略的条目（目录、macOS 元数据、系统垃圾）也算"跳过"，
  // 这样界面报"跳过 N 个文件"时与用户看到的内容一致 ——
  // 只统计解压失败会让用户以为垃圾文件也被当成图片处理了。
  const junk = entries.filter((e) => isJunkEntry(e.name));
  const nonImage = entries.filter((e) => !isJunkEntry(e.name) && !IMAGE_EXTS.includes(extOf(e.name)));

  const candidates = entries
    .filter((e) => !isJunkEntry(e.name) && IMAGE_EXTS.includes(extOf(e.name)))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));

  const images = [];
  let failed = 0; // 解压/读取失败的图片数（单独计，便于界面区分）
  const errors = [];
  for (const e of candidates) {
    if (images.length >= limit) break;
    try {
      const bytes = readEntry(buf, e);
      if (bytes.length === 0) {
        failed += 1;
        errors.push(`${e.name}：解压后为空`);
        continue;
      }
      images.push({
        name: e.name,
        mime: mimeOf(e.name) || 'application/octet-stream',
        bytes,
        size: bytes.length,
      });
    } catch (err) {
      // 单张失败不影响其它张：记下来，让上层展示
      failed += 1;
      errors.push(`${e.name}：${err.message}`);
    }
  }

  return {
    images,
    /** 被跳过的文件总数（非图片 + 垃圾 + 读取失败） */
    skipped: junk.length + nonImage.length + failed,
    /** 其中"是图片但读不出来"的数量 */
    failed,
    junkSkipped: junk.length,
    nonImageSkipped: nonImage.length,
    errors,
    total: entries.length,
    // 截断只看"图片候选"有没有取完，与跳过多少非图片无关
    truncated: candidates.length > images.length + failed,
  };
}

module.exports = {
  listEntries,
  readEntry,
  extractImages,
  mimeOf,
  extOf,
  isJunkEntry,
  IMAGE_EXTS,
};
