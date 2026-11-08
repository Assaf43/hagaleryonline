import { readFileSync, globSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
    'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray ' +
    'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue ' +
    'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew ' +
    'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue ' +
    'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
    'whitesmoke yellow yellowgreen'
  ).split(' '),
);

const COLOR_PROPS = /^(color|background|background-color|border(-[a-z]+)*-color|outline-color|fill|stroke)$/;
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/;
const COLOR_FN = /\b(?:rgb|rgba|hsl|hsla)\s*\(/i;
// "--black-a45" has no dash after "black-a"; the others always do.
const PRIMITIVE_STRICT = /var\(--(?:(?:gray|warm|red|green|amber|blue|text|size|round|ms|curve)-|black-a)/;

/** Returns the [start, end) offsets of the contents of every `styles:` literal. */
function styleRanges(source) {
  const ranges = [];
  const re = /\bstyles\s*:\s*(\[)?\s*(?=`)/g;
  let m;
  while ((m = re.exec(source))) {
    const isArray = Boolean(m[1]);
    let pos = re.lastIndex;
    for (;;) {
      if (source[pos] !== '`') break;
      let end = pos + 1;
      while (end < source.length && source[end] !== '`') end += source[end] === '\\' ? 2 : 1;
      ranges.push([pos + 1, end]);
      pos = end + 1;
      if (!isArray) break;
      const next = /^\s*,\s*(?=`)/.exec(source.slice(pos));
      if (!next) break;
      pos += next[0].length;
    }
    re.lastIndex = Math.max(re.lastIndex, pos);
  }
  return ranges;
}

export function findViolations(source) {
  const out = [];
  const lineAt = (offset) => source.slice(0, offset).split('\n').length;
  for (const [start, end] of styleRanges(source)) {
    const css = source.slice(start, end);
    const add = (index, message) => out.push({ line: lineAt(start + index), message });
    for (const m of css.matchAll(new RegExp(HEX, 'g'))) add(m.index, `raw hex color ${m[0]}`);
    for (const m of css.matchAll(new RegExp(COLOR_FN, 'gi'))) add(m.index, `raw color function ${m[0].trim()}`);
    for (const m of css.matchAll(new RegExp(PRIMITIVE_STRICT, 'g'))) add(m.index, `primitive token ${m[0]}`);
    for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]*)/gi)) {
      if (!COLOR_PROPS.test(m[1].toLowerCase())) continue;
      for (const w of m[2].matchAll(/(?<![\w-])[a-z]+(?![\w-]*\()(?![\w-])/gi)) {
        if (NAMED_COLORS.has(w[0].toLowerCase())) add(m.index + m[0].indexOf(m[2]) + w.index, `named color ${w[0]}`);
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

function main() {
  const files = [...globSync('apps/*/src/**/*.ts'), ...globSync('libs/shared/**/src/**/*.ts')].filter(
    (f) => !f.endsWith('.spec.ts') && !/(^|[\\/])(node_modules|dist)[\\/]/.test(f),
  );
  let count = 0;
  for (const file of files) {
    for (const v of findViolations(readFileSync(file, 'utf8'))) {
      console.error(`${file.replaceAll('\\', '/')}:${v.line} ${v.message}`);
      count++;
    }
  }
  if (count) {
    console.error(`\n${count} inline style violation(s): use semantic/component tokens.`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
