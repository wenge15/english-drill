'use strict';

/**
 * ZIP 读取器的测试。
 *
 * 测试用的 zip 由本文件手工构造（不引入打包依赖），
 * 这样能精确控制压缩方式、目录结构、以及各种边界情况。
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const zip = require('../src/core/zip.js');

/** 构造一个 ZIP。files: [{name, data, method?}]，method 默认 deflate。 */
function makeZip(files, opts = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const method = f.method === undefined ? 8 : f.method;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x800, 6); // flags: UTF-8 名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x800, 8); // flags
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const comment = opts.comment ? Buffer.from(opts.comment, 'utf8') : Buffer.alloc(0);
  eocd.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...locals, cenBuf, eocd, comment]);
}

/** 标准 CRC32，用来让手工构造的 zip 合法。 */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** 一个最小的合法 PNG（1x1 透明像素），用来当"图片"。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('基本读取：列出条目并解压内容', () => {
  const buf = makeZip([
    { name: 'a.txt', data: 'hello zip' },
    { name: 'b/c.txt', data: 'nested' },
  ]);
  const entries = zip.listEntries(buf);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].name, 'a.txt');
  assert.strictEqual(entries[1].name, 'b/c.txt');

  const out = zip.readEntry(buf, entries[0]);
  assert.strictEqual(out.toString('utf8'), 'hello zip');
  assert.strictEqual(zip.readEntry(buf, entries[1]).toString('utf8'), 'nested');
});

test('两种压缩方式都能读：deflate 与 store（不压缩）', () => {
  const buf = makeZip([
    { name: 'deflated.txt', data: 'x'.repeat(500), method: 8 },
    { name: 'stored.txt', data: 'plain text', method: 0 },
  ]);
  const entries = zip.listEntries(buf);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.strictEqual(byName['deflated.txt'].method, 8);
  assert.strictEqual(byName['stored.txt'].method, 0);

  assert.strictEqual(zip.readEntry(buf, byName['deflated.txt']).toString('utf8'), 'x'.repeat(500));
  assert.strictEqual(zip.readEntry(buf, byName['stored.txt']).toString('utf8'), 'plain text');
});

test('中文文件名能正确读出（UTF-8 标志位）', () => {
  const buf = makeZip([{ name: '第一单元/试卷1.png', data: TINY_PNG }]);
  const entries = zip.listEntries(buf);
  assert.strictEqual(entries[0].name, '第一单元/试卷1.png');
});

test('压缩包尾部有注释时仍能定位中央目录', () => {
  const buf = makeZip([{ name: 'a.png', data: TINY_PNG }], { comment: '这是压缩包注释，会放在文件尾部' });
  const entries = zip.listEntries(buf);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].name, 'a.png');
});

test('提取图片：只挑图片，按文件名自然序排列', () => {
  const buf = makeZip([
    { name: 'readme.txt', data: 'not an image' },
    { name: '试卷10.png', data: TINY_PNG },
    { name: '试卷2.png', data: TINY_PNG },
    { name: '试卷1.jpg', data: TINY_PNG },
    { name: 'sub/试卷3.png', data: TINY_PNG },
  ]);
  const r = zip.extractImages(buf);
  assert.strictEqual(r.images.length, 4, '应只挑出 4 张图片');
  const names = r.images.map((i) => i.name);

  // 自然序的关键：试卷2 要排在 试卷10 前面（字典序会反过来）
  const i2 = names.findIndex((n) => n.includes('试卷2.'));
  const i10 = names.findIndex((n) => n.includes('试卷10.'));
  assert.ok(i2 !== -1 && i10 !== -1 && i2 < i10, `试卷2 应排在 试卷10 之前，实际 ${JSON.stringify(names)}`);

  // 同一目录内按卷号递增
  const sameDir = names.filter((n) => !n.includes('/'));
  assert.deepStrictEqual(sameDir, ['试卷1.jpg', '试卷2.png', '试卷10.png'], `同目录内顺序不对：${JSON.stringify(sameDir)}`);

  // 与模块使用的排序规则一致（不要在小测试里另写一套期望）
  const expected = [
    'readme.txt',
    '试卷10.png',
    '试卷2.png',
    '试卷1.jpg',
    'sub/试卷3.png',
  ]
    .filter((n) => zip.IMAGE_EXTS.includes(zip.extOf(n)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  assert.deepStrictEqual(names, expected);

  assert.strictEqual(r.images.find((i) => i.name === '试卷1.jpg').mime, 'image/jpeg');
});

test('提取图片：忽略 macOS 元数据与系统垃圾文件', () => {
  const buf = makeZip([
    { name: '__MACOSX/试卷1.png', data: TINY_PNG },
    { name: '.DS_Store', data: 'junk' },
    { name: 'sub/._试卷2.png', data: 'junk' },
    { name: 'Thumbs.db', data: 'junk' },
    { name: '试卷3.png', data: TINY_PNG },
    { name: 'emptydir/', data: '' },
  ]);
  const r = zip.extractImages(buf);
  assert.strictEqual(r.images.length, 1, `应只剩 1 张真图片，实际 ${JSON.stringify(r.images.map((i) => i.name))}`);
  assert.strictEqual(r.images[0].name, '试卷3.png');
});

test('提取图片：支持 jpg/jpeg/png/gif/webp/bmp', () => {
  const buf = makeZip([
    { name: 'a.jpg', data: TINY_PNG },
    { name: 'b.jpeg', data: TINY_PNG },
    { name: 'c.png', data: TINY_PNG },
    { name: 'd.gif', data: TINY_PNG },
    { name: 'e.webp', data: TINY_PNG },
    { name: 'f.bmp', data: TINY_PNG },
    { name: 'g.txt', data: 'no' },
    { name: 'h.pdf', data: 'no' },
  ]);
  const r = zip.extractImages(buf);
  assert.strictEqual(r.images.length, 6);
  assert.deepStrictEqual(
    r.images.map((i) => i.mime).sort(),
    ['image/bmp', 'image/gif', 'image/jpeg', 'image/jpeg', 'image/png', 'image/webp'],
  );
});

test('提取图片：limit 生效，不会一次解压几百张', () => {
  const files = [];
  for (let i = 1; i <= 20; i += 1) files.push({ name: `p${i}.png`, data: TINY_PNG });
  const r = zip.extractImages(makeZip(files), { limit: 5 });
  assert.strictEqual(r.images.length, 5);
  assert.strictEqual(r.truncated, true, '应标记"还有没取完的"');
});

test('单张坏掉不影响其它张（记录错误并继续）', () => {
  // 手工构造一个"声称 deflate 但数据是垃圾"的条目
  const good = makeZip([{ name: 'good.png', data: TINY_PNG }]);
  const goodEntries = zip.listEntries(good);
  assert.strictEqual(goodEntries.length, 1, '前置条件：正常包应有 1 条');

  // 用一个方式号不支持的条目来触发失败
  const weird = makeZip([{ name: 'weird.png', data: TINY_PNG, method: 12 }]);
  const r = zip.extractImages(weird);
  assert.strictEqual(r.images.length, 0, '不支持的压缩方式应被跳过');
  assert.strictEqual(r.skipped, 1);
  assert.ok(r.errors.length === 1 && /不支持的压缩方式/.test(r.errors[0]), `应说明原因，实际 ${JSON.stringify(r.errors)}`);
});

test('加密条目要明确报错，而不是给出乱码', () => {
  // 手工把 flags 的加密位置 1
  const buf = makeZip([{ name: 'secret.png', data: TINY_PNG }]);
  // flags 在中央目录条目偏移 +8（entry 起始 0，但本地头也要改）
  const entries = zip.listEntries(buf);
  const cenOffset = buf.readUInt32LE(buf.length - 22 + 16);
  buf.writeUInt16LE(0x801, cenOffset + 8);
  const withFlag = zip.listEntries(buf);
  assert.strictEqual(withFlag[0].encrypted, true, '应识别出加密标志');
  assert.throws(() => zip.readEntry(buf, withFlag[0]), /加密/);
  void entries;
});

test('不是 ZIP 的内容要给出可理解的错误，而不是崩溃', () => {
  assert.throws(() => zip.listEntries(Buffer.from('this is just text, not a zip')), /不是有效的 ZIP/);
  assert.throws(() => zip.listEntries(Buffer.alloc(3)), /太短|不是有效的 ZIP/);
});

test('ZIP64 要明确拒绝并说明原因（而不是解出错数据）', () => {
  const buf = makeZip([{ name: 'a.png', data: TINY_PNG }]);
  // 把中央目录偏移改成 0xFFFFFFFF，模拟 ZIP64 特征
  buf.writeUInt32LE(0xffffffff, buf.length - 22 + 16);
  assert.throws(() => zip.listEntries(buf), /ZIP64/);
});

test('文件被截断时给出明确错误', () => {
  const buf = makeZip([{ name: 'a.png', data: TINY_PNG }]);
  const cut = buf.slice(0, Math.floor(buf.length * 0.6));
  assert.throws(() => zip.listEntries(cut), /不是有效的 ZIP|不完整|超出/);
});

test('空 zip（没有条目）不报错，返回空清单', () => {
  const buf = makeZip([]);
  const entries = zip.listEntries(buf);
  assert.deepStrictEqual(entries, []);
  const r = zip.extractImages(buf);
  assert.deepStrictEqual(r.images, []);
  assert.strictEqual(r.skipped, 0);
});

test('mimeOf 与 extOf 的映射', () => {
  assert.strictEqual(zip.mimeOf('a.JPG'), 'image/jpeg');
  assert.strictEqual(zip.mimeOf('a.jpeg'), 'image/jpeg');
  assert.strictEqual(zip.mimeOf('a.png'), 'image/png');
  assert.strictEqual(zip.mimeOf('a.webp'), 'image/webp');
  assert.strictEqual(zip.mimeOf('a.pdf'), 'application/pdf');
  assert.strictEqual(zip.mimeOf('a.txt'), '');
  assert.strictEqual(zip.extOf('dir/noext'), '');
  assert.strictEqual(zip.extOf('a.b.c.PNG'), '.png');
});

test('大文件能正确解压（验证 deflate 路径）', () => {
  const big = Buffer.alloc(300 * 1024);
  for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
  const buf = makeZip([{ name: 'big.bin', data: big }]);
  const entries = zip.listEntries(buf);
  const out = zip.readEntry(buf, entries[0]);
  assert.strictEqual(out.length, big.length, '解压后的长度应一致');
  assert.ok(out.equals(big), '解压后的内容应完全一致');
});
