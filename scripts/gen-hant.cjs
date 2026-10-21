/* 生成繁体中文转换表：把 src/ 里用到的简体字词按 OpenCC s2twp（台湾正体 + 台湾用语）转好，写回 src/services/hant.ts 的 crisp-hant 标记之间。
   改了任何中文文案都要重跑一次（npm run hant），i18n 测试会比对指纹提醒。
   需要 opencc-js（devDependency，先 npm install）。只在生成时用到，插件运行时不依赖它。

   表分两段，和 OpenCC 的转换顺序一致：s 是简→繁的字和词，t 是台湾用语和异体字（键是繁体）。
   每段只收文案里实际出现的条目，运行时（hant.ts 的 toHant）按最长匹配替换，对源码里的文案和 OpenCC 结果逐字一致。 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BEGIN = '/* crisp-hant:begin */';
const END = '/* crisp-hant:end */';

/* OpenCC 在这些词上不合台湾习惯或会转错，按这里的写法出（键简体、值最终繁体）。
   新增文案里遇到别扭的转换就加在这里，再跑 npm run hant。 */
const OVERRIDES = {
  复盘: '復盤', // OpenCC 转成「覆盤」
  番茄钟: '番茄鐘', // 钟单字转「鍾」
  复选框: '核取方塊', // OpenCC 转成「覈取方塊」
  权限: '權限', // OpenCC twp 转成「許可權」
  质量: '品質', // 台湾「質量」指物理质量
  控制台: '主控台',
  后台: '後台',
  像素: '像素', // twp 转成「畫素」，台湾也常用像素
  周: '週', // 单独的「周」在这里都指星期（自然周、周起始日），OpenCC 不转
  台: '台', // 量词「3 台设备」，台湾写台不写臺
  访问: '存取', // 只用于访问文件系统
  未通过: '未通過', // 「通过」在这几处是通过校验，不是 twp 的「透過」（经由）
  校验通过: '校驗通過',
  验签通过: '驗簽通過',
};

/** 去掉注释和生成的表，剩下代码里的汉字串。注释里的中文不显示给用户，不进表。 */
function hanRuns(source) {
  const start = source.indexOf(BEGIN), end = source.indexOf(END);
  const body = start >= 0 && end > start ? source.slice(0, start) + source.slice(end + END.length) : source;
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');
  return [...new Set(code.match(/\p{Script=Han}+/gu) || [])].sort();
}

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'src/services/hant.ts');

/** src/ 下所有源码拼在一起（生成的表本身由 hanRuns 去掉）。 */
function readSources(dir = path.join(ROOT, 'src')) {
  const parts = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) parts.push(readSources(full));
    else if (/\.tsx?$/.test(entry.name)) parts.push(fs.readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}

/** 文案指纹：汉字串集合变了（新增、删改中文）就会变。 */
function fingerprint(source) {
  return crypto.createHash('sha256').update(hanRuns(source).join('\n')).digest('hex').slice(0, 16);
}

/** 运行时用的同一套最长匹配（hant.ts 里 toHant 的逻辑与此一致）。 */
function convertWith(map, text) {
  const max = Math.max(1, ...Object.keys(map).map(k => k.length));
  let out = '';
  for (let i = 0; i < text.length;) {
    let hit = 0;
    for (let n = Math.min(max, text.length - i); n > 0; n--) {
      if (Object.prototype.hasOwnProperty.call(map, text.substr(i, n))) { hit = n; break; }
    }
    if (hit) { out += map[text.substr(i, hit)]; i += hit; } else { out += text[i]; i++; }
  }
  return out;
}

function parseDicts(group) {
  const entries = [];
  for (const d of group) for (const line of d.split('|')) { const [k, v] = line.split(' '); if (k && v) entries.push([k, v]); }
  return entries;
}

/** 某段字典里在 corpus 中出现过的条目。键必须是汉字串（文案里汉字串之间没有别的字符）。
    不改字的词也要留（如「一克」），它们挡住更短的匹配；不改字的单字没用，丢掉。 */
function pick(entries, corpus) {
  const map = {};
  for (const [k, v] of entries) if (/^\p{Script=Han}+$/u.test(k) && corpus.includes(k)) map[k] = v;
  for (const [k, v] of Object.entries(map)) if (k === v && k.length === 1) delete map[k];
  return map;
}

const serialize = (map) => Object.keys(map).sort().map(k => `${k} ${map[k]}`).join('|');

/** 繁体再转一次不能变（tr 里常嵌套 tr，插值进来的文案已经转过）：把会被再次匹配的结果补成不改字的词。 */
function protect(map) {
  for (const v of Object.values({ ...map })) {
    if (!/^\p{Script=Han}+$/u.test(v) || v.length < 2) continue;
    if (Object.keys(map).some(k => k !== v && v.includes(k))) map[v] = v;
  }
  return map;
}

function generate(file = TARGET) {
  const OpenCC = require('opencc-js');
  const { from, to } = require('opencc-js/preset');
  const target = fs.readFileSync(file, 'utf8');
  if (!target.includes(BEGIN) || !target.includes(END)) throw new Error(`${file} 里没有 crisp-hant 标记`);
  const source = readSources();
  const runs = hanRuns(source);
  const corpus = runs.join('\n');
  const overrides = Object.entries(OVERRIDES).map(([k, v]) => `${k} ${v}`).join('|');
  const sEntries = [...parseDicts(from.cn), ...parseDicts([overrides])];
  const tEntries = [...parseDicts(to.twp), ...Object.values(OVERRIDES).map(v => [v, v])];
  const s = pick(sEntries, corpus);
  const stage1 = runs.map(r => convertWith(s, r));
  const t = pick(tEntries, stage1.join('\n'));
  const reference = OpenCC.ConverterFactory([...from.cn, overrides], [...to.twp, Object.values(OVERRIDES).map(v => `${v} ${v}`).join('|')]);
  const convert = (text) => convertWith(t, convertWith(s, text));
  const wrong = runs.filter((r) => convert(r) !== reference(r));
  if (wrong.length) throw new Error(`和 OpenCC 结果不一致：${wrong.slice(0, 10).join('、')}`);
  // 再转一次要不变：补完不改字的词后重查
  const hant = runs.map(convert);
  protect(s); protect(t);
  const unstable = hant.filter((v, i) => convert(v) !== v || convert(runs[i]) !== v);
  if (unstable.length) throw new Error(`再转一次会变：${unstable.slice(0, 10).join('、')}`);
  const table = JSON.stringify({ fp: fingerprint(source), s: serialize(s), t: serialize(t) });
  const start = target.indexOf(BEGIN) + BEGIN.length;
  fs.writeFileSync(file, target.slice(0, start) + table + target.slice(target.indexOf(END)));
  return { runs: runs.length, s: Object.keys(s).length, t: Object.keys(t).length };
}

module.exports = { hanRuns, fingerprint, convertWith, readSources, BEGIN, END };

if (require.main === module) {
  const file = TARGET;
  const stats = generate(file);
  console.log(`已更新 ${path.basename(file)}：${stats.runs} 段文案，简→繁 ${stats.s} 条，台湾用语 ${stats.t} 条`);
}
