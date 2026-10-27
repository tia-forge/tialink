#!/usr/bin/env node
/*
 * tialink-batch.mjs — 用点表批量生成 TIA Portal 工程对象
 *
 * 依赖：Node.js 18+、本机运行中的 TiaLink（默认 http://localhost:8080），无 npm 依赖。
 *
 * 关键点：批量复制不是"一模一样复制"。每台设备的差异有三类，全部来自点表（CSV）：
 *   1. 标识：块名 / 块号 / 背景 DB 名 / 注释里的台号
 *   2. IO 地址：不连续、台与台之间可能夹着别的信号 —— 所以地址只从点表来，绝不 i*8 算出来
 *   3. 参数：延时、量程、阈值 —— 写进块的默认值（copy 模式）或调用实参（instance 模式）
 *
 *   node tialink-batch.mjs clone --template FB_MotorSeq --spec pumps.csv --mode instance --calls FB_PumpCalls
 *   node tialink-batch.mjs clone --template FB_MotorSeq --spec pumps.csv --mode copy --base 10 --db-base 10
 *   node tialink-batch.mjs export --zip plc3.zip --kinds blocks,tagTables
 *   node tialink-batch.mjs import --zip plc3.zip --to PLC_2 --chunk 100
 *
 * 写操作一律先 dryRun 预检；全程不保存工程（保存由人决定）。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------- 参数
function parseArgv(argv) {
  const out = { _: [], arg: [], replace: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    const take = next !== undefined && !next.startsWith('--');
    if (key === 'arg' || key === 'replace') { if (take) (out[key] ||= []).push(next), i++; continue; }
    if (out[key] !== undefined && key !== 'dry') {  // 允许重复 --arg 之外的同名参数取最后一个
      out[key] = take ? next : true; if (take) i++; continue;
    }
    out[key] = take ? next : true;
    if (take) i++;
  }
  return out;
}
const args = parseArgv(process.argv.slice(2));
const cmd = args._[0];
const host = String(args.host || 'http://localhost:8080').replace(/\/+$/, '');
const device = args.device;

// ---------------------------------------------------------------- HTTP
async function get(path, query = {}) {
  const url = new URL(host + '/api/v1' + path);
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
async function post(path, query = {}, body) {
  const url = new URL(host + '/api/v1' + path);
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok && json.success !== false) throw new Error(`POST ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}
async function rawExport(query) {
  const url = new URL(host + '/api/v1/export');
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`export ${query.name} -> ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

// ---------------------------------------------------------------- SimaticML
// 一个 <Document> 可装多个同种根对象，但 ID 必须全局唯一：
//   ID  ← 十六进制字符串
//   UId ← 十进制 int32（按十六进制平移，第 10 份就会炸："A003" 不是有效 Int32）
function shiftIds(xml, offset) {
  return xml
    .replace(/ ID="([0-9A-F]+)"/g, (_, v) => ` ID="${(parseInt(v, 16) + offset).toString(16).toUpperCase()}"`)
    .replace(/ UId="(\d+)"/g, (_, v) => ` UId="${parseInt(v, 10) + offset}"`);
}
function splitDoc(xml) {
  const end = xml.indexOf('</Document>');
  const first = xml.search(/<SW\.[A-Za-z.]+ ID="/);
  return { head: xml.slice(0, first), body: xml.slice(first, end) };
}
function rootOf(xml) { return (xml.match(/<(SW\.[A-Za-z.]+) ID="/) || [])[1]; }

function parseInterface(blockXml) {
  const out = { inputs: [], outputs: [] };
  for (const section of ['Input', 'Output']) {
    const start = blockXml.indexOf(`<Section Name="${section}"`);
    if (start < 0) continue;
    const end = blockXml.indexOf('</Section>', start);
    const seg = blockXml.slice(start, end < 0 ? blockXml.length : end);
    const re = /<Member Name="([^"]+)" Datatype="([^"]+)"/g;
    let m;
    while ((m = re.exec(seg))) {
      const after = seg.slice(m.index, seg.indexOf('</Member>', m.index));
      const cm = after.match(/<MultiLanguageText[^>]*>([^<]*)<\/MultiLanguageText>/);
      out[section === 'Input' ? 'inputs' : 'outputs'].push({ name: m[1], datatype: m[2], comment: cm ? cm[1] : '' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- CSV 点表
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  const header = lines[0].split(',').map(s => s.trim());
  const rows = lines.slice(1).map(l => {
    const cells = l.split(',').map(s => s.trim());
    const row = {};
    header.forEach((h, i) => row[h] = cells[i] ?? '');
    return row;
  });
  return { header, rows };
}

// ---------------------------------------------------------------- clone
async function cmdClone() {
  const t0 = Date.now();
  const template = args.template || die('--template 必填（模板块名）');
  const mode = args.mode || 'instance';
  if (!['instance', 'copy'].includes(mode)) die('--mode 只能是 instance 或 copy');
  const spec = args.spec || die('--spec 必填（点表 CSV）');
  const { header, rows } = parseCsv(await readFile(spec, 'utf8'));
  if (!rows.length) die('点表里没有数据行');

  const tplXml = await rawExport({ device, name: template, options: 'defaults' });
  const iface = parseInterface(tplXml);
  const boolIn = iface.inputs.filter(m => m.datatype === 'Bool');
  const boolOut = iface.outputs.filter(m => m.datatype === 'Bool');

  // 点表列名必须对得上接口；对不上就报出来，别猜
  const boolNames = [...boolIn, ...boolOut].map(m => m.name);
  const missing = boolNames.filter(n => !header.includes(n));
  if (missing.length) die(`点表缺少列：${missing.join(', ')}`);
  const extra = header.filter(h => !boolNames.includes(h) && !['no', 'name'].includes(h) && !iface.inputs.some(m => m.name === h));
  if (extra.length) console.log(`提示：点表里这些列用不上（既不是接口成员，也不是 no/name）：${extra.join(', ')}`);

  // 每台设备：名字、块号、地址、参数
  for (const r of rows) {
    if (!r.name) die('点表每行都要有 name');
    for (const n of boolNames) {
      const v = r[n];
      if (!/^%[IQM]\d+\.\d$/.test(v || '')) die(`${r.name} 的 ${n} 不是合法地址："${v}"（要 %I0.0 这种）`);
    }
  }
  // 地址不能重复（这是手工复制最容易犯、编译又只给一条警告的错）
  const all = rows.flatMap(r => boolNames.map(n => r[n]));
  const dup = all.filter((v, i) => all.indexOf(v) !== i);
  if (dup.length) die(`点表里地址重复：${[...new Set(dup)].join(', ')}`);

  const model = await get('/model', { device, kinds: 'blocks' });
  const tplBlock = model.blocks.find(b => b.name === template);
  const tplDb = model.blocks.find(b => b.instanceOf === template);
  if (mode === 'copy' && !tplDb) die(`${template} 没有背景 DB，copy 模式无法复制实例`);
  // 实例 DB 的模板：目标设备里有就用它的，没有就用 FB 的接口现场合成一份
  // （instance 模式下 DB 必须存在，否则调用段全是 'Tag "DB_P001" not defined'）
  const dbXml = tplDb ? await rawExport({ device, name: tplDb.name, options: 'defaults' }) : synthInstanceDb(tplXml, template);

  const base = Number(args.base || nextFree(model.blocks, tplBlock.blockClass));
  const dbBase = Number(args['db-base'] || base);
  if (mode === 'copy') {
    // 重跑（覆盖已有同名块）是允许的；只有新块占了别人的编号才报错
    const used = new Set(model.blocks.filter(b => b.blockClass === tplBlock.blockClass).map(b => b.number));
    const names = new Set(model.blocks.map(b => b.name));
    rows.forEach((r, i) => { const target = 'FB_' + r.name; if (!names.has(target) && used.has(base + i)) die(`块号 ${base + i} 已被占用（${target} 是新块），换 --base`); });
  }

  const rpt = [];
  const tplParts = splitDoc(tplXml);

  // ---- 1) copy 模式：N 份 FB，各自带自己的参数默认值与标题
  const ops = [];
  if (mode === 'copy') {
    const bodies = rows.map((r, i) => {
      let x = tplParts.body
        .replace(/<Name>[^<]*<\/Name>/, `<Name>FB_${r.name}</Name>`)
        .replace(/<Number>[^<]*<\/Number>/, `<Number>${base + i}</Number>`)
        .replace(/<AutoNumber>true<\/AutoNumber>/, '<AutoNumber>false</AutoNumber>');
      // 每份把自己的非 Bool 输入默认值换成点表里的值（延时、量程…）
      for (const m of iface.inputs.filter(m => m.datatype !== 'Bool' && r[m.name])) {
        x = setStartValue(x, m.name, r[m.name]);
      }
      for (const rule of args.replace) x = applyReplace(x, rule, r);
      x = setBlockTitle(x, `${r.name} 控制（模板 ${template}）`);
      return shiftIds(x, (i + 1) * 0x1000);
    });
    ops.push({ what: `FB × ${rows.length}（${mode}）`, body: tplParts.head + bodies.join('\n') + '</Document>', q: { device, format: 'simaticml', override: true } });
  }

  // ---- 2) 实例 DB：每台一个，InstanceOf 指向自己的 FB
  if (dbXml) {
    const dbParts = splitDoc(dbXml);
    const bodies = rows.map((r, i) => shiftIds(
      dbParts.body
        .replace(/<Name>[^<]*<\/Name>/, `<Name>DB_${r.name}</Name>`)
        .replace(/<Number>[^<]*<\/Number>/, `<Number>${dbBase + i}</Number>`)
        .replace(/<AutoNumber>true<\/AutoNumber>/, '<AutoNumber>false</AutoNumber>')
        .replace(/<InstanceOfName>[^<]*<\/InstanceOfName>/, `<InstanceOfName>${mode === 'copy' ? 'FB_' + r.name : template}</InstanceOfName>`),
      (i + 1) * 0x1000));
    ops.push({ what: `背景 DB × ${rows.length}`, body: dbParts.head + bodies.join('\n') + '</Document>', q: { device, format: 'simaticml', override: true } });
  }

  // ---- 3) 变量表：地址照点表原样落，一个都不算
  const tableName = String(args.tags || '');
  if (tableName) {
    const tagsXml = buildTagTable(tableName, iface, rows);
    ops.push({ what: `变量表 ${tableName}（${rows.length} 台）`, body: tagsXml, q: { device, format: 'simaticml', override: true } });
  }

  // ---- 4) 调用段：一个 SCL 外部源，参数用点表里的实参
  if (args.calls) {
    const scl = buildCalls(String(args.calls), iface, rows, { mode, withTags: !!tableName });
    // SCL 走 POST /import-scl（/import 只吃 SimaticML）
    ops.push({ what: `调用段 ${args.calls}`, path: '/import-scl', body: scl, q: { device, name: `Src_${args.calls}`, generate: true } });
  }

  console.log(`模板 ${template}：${boolIn.length} Bool 入 / ${boolOut.length} Bool 出；点表 ${rows.length} 台（${rows[0].name} … ${rows[rows.length - 1].name}），模式 ${mode}；准备 ${Date.now() - t0} ms`);

  const dry = !!args.dry;
  for (const op of ops) {
    const t = Date.now();
    // dryRun 只对 SimaticML 有效：format=scl 时传了会被当 XML 解析，直接 400
    const dryQ = dry && !op.path ? 'true' : undefined;
    const r = await post(op.path || '/import', { ...op.q, dryRun: dryQ }, op.body);
    const ms = Date.now() - t;
    const ok = r.success !== false;
    rpt.push({ op: op.what, ms, ok, n: (r.imported || []).length, chg: r.tagChanges, err: r.error || '' });
    if (!ok) { console.log(`  ✗ ${op.what}: ${r.error}`); if (r.errorLocation) console.log('    ' + JSON.stringify(r.errorLocation)); break; }
  }
  printTable(rpt);
  if (!dry && rpt.every(r => r.ok)) await compileAndReport();
  else if (dry) console.log('dryRun：只预检，没有写工程');
  await reportDirty();
}

function synthInstanceDb(fbXml, fbName) {
  const i = fbXml.indexOf('<Interface>');
  const j = fbXml.indexOf('</Interface>');
  if (i < 0 || j < 0) die('模板 FB 里找不到 <Interface>，无法合成实例 DB');
  // 实例 DB 只接受 Input/Output/InOut/Static/Memory：FB 的 Temp、Constant 段必须去掉
  // （TIA 的报错只说'"Temp"部分对此块无效'，不说哪来的）
  let iface = fbXml.slice(i, j + '</Interface>'.length);
  for (const drop of ['Constant', 'Temp', 'None']) {
    const open = iface.indexOf(`<Section Name="${drop}"`);
    if (open < 0) continue;
    const tagEnd = iface.indexOf('>', open);
    const selfClosing = iface.slice(open, tagEnd).endsWith('/');
    const end = selfClosing ? tagEnd + 1 : iface.indexOf('</Section>', open) + '</Section>'.length;
    iface = iface.slice(0, open) + iface.slice(end);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <Engineering version="V19" />
  <SW.Blocks.InstanceDB ID="0">
    <AttributeList>
      <AutoNumber>true</AutoNumber>
      <InstanceOfName>${fbName}</InstanceOfName>
      <InstanceOfType>FB</InstanceOfType>
      ${iface}
      <Name>DB_TEMPLATE</Name>
      <Namespace />
      <Number>1</Number>
      <ProgrammingLanguage>DB</ProgrammingLanguage>
    </AttributeList>
  </SW.Blocks.InstanceDB>
</Document>`;
}

function nextFree(blocks, cls) {
  const used = blocks.filter(b => b.blockClass === cls).map(b => b.number);
  return (Math.max(0, ...used) + 1);
}
function setStartValue(xml, member, value) {
  const start = xml.indexOf(`<Member Name="${member}"`);
  if (start < 0) return xml;
  const end = xml.indexOf('</Member>', start);
  const seg = xml.slice(start, end);
  if (!/<StartValue>/.test(seg)) return xml;
  return xml.slice(0, start) + seg.replace(/<StartValue>[^<]*<\/StartValue>/, `<StartValue>${value}</StartValue>`) + xml.slice(end);
}
// 藏在文本里的差异（网络注释、字符串常量、标题）没法从接口推出来，只能给替换规则：
//   --replace '1 号电机={no} 号风机主电机'  --replace '本台={name}'
function applyReplace(xml, rule, row) {
  const i = rule.indexOf('=');
  if (i < 0) return xml;
  const from = rule.slice(0, i);
  const to = rule.slice(i + 1).replace(/{no}/g, row.no || '').replace(/{name}/g, row.name);
  return xml.split(from).join(to);
}

function setBlockTitle(xml, text) {
  // 块的 Title 是最后一个 CompositionName="Title" 的 MultilingualText
  const idx = xml.lastIndexOf('CompositionName="Title"');
  if (idx < 0) return xml;
  const end = xml.indexOf('</MultilingualText>', idx);
  const seg = xml.slice(idx, end);
  return xml.slice(0, idx) + seg.replace(/<Text\s*\/>|<Text>[^<]*<\/Text>/, `<Text>${text}</Text>`) + xml.slice(end);
}

function buildTagTable(tableName, iface, rows) {
  let id = 1;
  const h = n => n.toString(16).toUpperCase();
  const cell = (name, addr, comment) => `<SW.Tags.PlcTag ID="${h(id++ * 3)}" CompositionName="Tags">
        <AttributeList>
          <DataTypeName>Bool</DataTypeName>
          <LogicalAddress>${addr}</LogicalAddress>
          <Name>${name}</Name>
        </AttributeList>
        <ObjectList>
          <MultilingualText ID="${h(id++ * 3)}" CompositionName="Comment">
            <ObjectList>
              <MultilingualTextItem ID="${h(id++ * 3)}" CompositionName="Items">
                <AttributeList>
                  <Culture>zh-CN</Culture>
                  <Text>${comment}</Text>
                </AttributeList>
              </MultilingualTextItem>
            </ObjectList>
          </MultilingualText>
        </ObjectList>
      </SW.Tags.PlcTag>`;
  const tags = [];
  for (const r of rows) {
    for (const m of iface.inputs.filter(x => x.datatype === 'Bool'))
      tags.push(cell(`${r.name}_${m.name}`, r[m.name], `${r.no || ''} ${r.name} ${m.comment || m.name}`.trim()));
    for (const m of iface.outputs.filter(x => x.datatype === 'Bool'))
      tags.push(cell(`${r.name}_${m.name}`, r[m.name], `${r.no || ''} ${r.name} ${m.comment || m.name}`.trim()));
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <Engineering version="V19" />
  <SW.Tags.PlcTagTable ID="0">
    <AttributeList>
      <Name>${tableName}</Name>
    </AttributeList>
    <ObjectList>
${tags.map(t => '      ' + t).join('\n')}
    </ObjectList>
  </SW.Tags.PlcTagTable>
</Document>`;
}

function buildCalls(name, iface, rows, { mode, withTags }) {
  const extra = args.arg.map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; });
  const blocks = rows.map((r, i) => {
    const params = [];
    for (const m of iface.inputs) {
      if (m.datatype === 'Bool') { if (withTags) params.push(`${m.name} := "${r.name}_${m.name}"`); }
      else if (r[m.name]) params.push(`${m.name} := ${r[m.name]}`);
      else { const hit = extra.find(([k]) => k === m.name); if (hit) params.push(`${m.name} := ${hit[1].replace(/\{n\}/g, r.no || i + 1)}`); }
    }
    for (const m of iface.outputs) if (m.datatype === 'Bool' && withTags) params.push(`${m.name} => "${r.name}_${m.name}"`);
    const pad = ' '.repeat(10);
    return `\t"DB_${r.name}"(${params.join(',\n' + pad)});`;
  });
  return `FUNCTION_BLOCK "${name}"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
   VAR
   END_VAR

BEGIN
${blocks.join('\n\n')}
END_FUNCTION_BLOCK`;
}

async function compileAndReport() {
  const t = Date.now();
  const c = await post('/compile', { device });
  const msgs = (c.messages || []).filter(m => !/successfully compiled/.test(m) && m.trim());
  console.log(`编译 ${Date.now() - t} ms：errors=${c.errorCount} warnings=${c.warningCount} state=${c.state}`);
  for (const m of msgs.slice(0, 12)) console.log('  ' + m);
}
async function reportDirty() {
  const h = await get('/health');
  console.log(`工程 ${h.project}：dirty=${h.dirty}（TiaLink 不会替你保存，保存由人决定）`);
}

// ---------------------------------------------------------------- export / import
async function cmdExport() {
  const kinds = String(args.kinds || 'blocks');
  const t = Date.now();
  const url = new URL(host + '/api/v1/export-all');
  url.searchParams.set('kinds', kinds);
  if (device) url.searchParams.set('device', device);
  url.searchParams.set('archive', 'true');
  const res = await fetch(url);
  if (!res.ok) die(`export-all ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = String(args.zip || `${device || 'export'}-${kinds.replace(/,/g, '-')}.zip`);
  await writeFile(zip, buf);
  console.log(`export-all ${kinds} → ${zip}：${(buf.length / 1024).toFixed(0)} KB，${((Date.now() - t) / 1000).toFixed(1)} s`);
}

async function cmdImport() {
  const zip = String(args.zip || die('--zip 必填'));
  const to = args.to || device || die('--to 或 --device 必填（目标设备）');
  // 不依赖 tar/unzip：Windows 上 msys tar 会把 'C:' 当远程主机，直接读 ZIP 更稳
  const entries = unzip(await readFile(zip));
  const files = entries.filter(e => e.name.toLowerCase().endsWith('.xml'));

  // 一个 Document 里只能有同一种根对象 → 按根对象分组，每组再按 --chunk 分批发
  // 顺序有依赖：UDT → FB/FC/OB → 实例 DB → 变量表（实例 DB 依赖它的 FB）
  const ORDER = ['SW.Types.PlcStruct', 'SW.Blocks.FB', 'SW.Blocks.FC', 'SW.Blocks.OB', 'SW.Blocks.GlobalDB', 'SW.Blocks.InstanceDB', 'SW.Tags.PlcTagTable'];
  const groups = new Map();
  for (const f of files) {
    const xml = f.data.toString('utf8');
    const root = rootOf(xml);
    if (!root) continue;
    const parts = splitDoc(xml);
    if (!groups.has(root)) groups.set(root, { head: parts.head, bodies: [] });
    groups.get(root).bodies.push(parts.body);
  }
  console.log(`解开 ${files.length} 个 XML（${entries.length} 个文件），根对象：${[...groups].map(([k, v]) => `${k}×${v.bodies.length}`).join(', ')}`);

  const chunk = Number(args.chunk || 100);
  const dry = !!args.dry;
  const rows = [];
  const ordered = [...groups.entries()].sort((a, b) => (ORDER.indexOf(a[0]) + 99 * (ORDER.indexOf(a[0]) < 0)) - (ORDER.indexOf(b[0]) + 99 * (ORDER.indexOf(b[0]) < 0)));
  for (const [root, g] of ordered) {
    for (let off = 0; off < g.bodies.length; off += chunk) {
      const slice = g.bodies.slice(off, off + chunk);
      const doc = g.head + slice.map((b, k) => shiftIds(b, (k + 1) * 0x1000)).join('\n') + '</Document>';
      const t = Date.now();
      const r = await post('/import', { device: to, format: 'simaticml', override: true, dryRun: dry ? 'true' : undefined }, doc);
      rows.push({ op: `${root.split('.').pop()} ${off + 1}-${off + slice.length}`, ms: Date.now() - t, ok: r.success !== false, n: (r.imported || []).length, chg: r.tagChanges, err: r.error || '' });
    }
  }
  printTable(rows);
  if (!dry && rows.every(r => r.ok)) { const t = Date.now(); const c = await post('/compile', { device: to }); console.log(`编译 ${to} ${Date.now() - t} ms：errors=${c.errorCount} warnings=${c.warningCount}`); }
}
function unzip(buf) {
  // 最小 ZIP 读取器：只认 中央目录 + deflate/stored，无依赖
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26), lxlen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnlen + lxlen;
    const raw = buf.slice(dataStart, dataStart + csize);
    if (!name.endsWith('/')) out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}


// ---------------------------------------------------------------- 输出
function printTable(rows) {
  if (!rows.length) return;
  const w = Math.max(...rows.map(r => r.op.length));
  for (const r of rows) {
    const extra = r.chg ? `（+${r.chg.added} 变量）` : (r.n ? `（${r.n} 个对象）` : '');
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.op.padEnd(w)} ${String(r.ms).padStart(6)} ms ${extra}${r.err ? '  ' + r.err.slice(0, 200) : ''}`);
  }
}
function die(msg) { console.error('错误：' + msg); process.exit(2); }

// ---------------------------------------------------------------- main
switch (cmd) {
  case 'clone': await cmdClone(); break;
  case 'export': await cmdExport(); break;
  case 'import': await cmdImport(); break;
  default:
    console.log(`用法：
  clone  --template FB_X --spec devices.csv [--mode instance|copy] [--base 10] [--db-base 10] [--tags Table] [--calls FB_Calls] [--dry]
  export --zip out.zip [--kinds blocks,tagTables]
  import --zip out.zip --to PLC_2 [--chunk 100] [--dry]
公共参数：--host http://localhost:8080  --device PLC_1`);
    process.exit(1);
}
