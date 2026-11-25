// A side-by-side line diff for the bulk edit review screen.
// The AI's edits are additions, so most diffs are runs of added lines between
// unchanged ones, but a hand edit can change anything, so this is a general
// longest-common-subsequence diff on lines. Long unchanged stretches are folded.
//
// Rows: { kind: 'same' | 'add' | 'del' | 'change' | 'skip', left, right, leftNo, rightNo }
// ('skip' holds the number of folded lines in `left`.)

const MAX_CELLS = 4_000_000;
const CONTEXT_LINES = 3;

const split = (text) => String(text).replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd());

// The edit script between two line arrays: [{ op: 'same' | 'del' | 'add', line }].
function script(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const out = a.slice(0, start).map((line) => ({ op: 'same', line }));

  if ((middleA.length + 1) * (middleB.length + 1) > MAX_CELLS) {
    // Too big to align: show the whole middle as removed, then added.
    out.push(...middleA.map((line) => ({ op: 'del', line })), ...middleB.map((line) => ({ op: 'add', line })));
  } else {
    // lcs[i][j]: length of the common subsequence of middleA[i..] and middleB[j..].
    const width = middleB.length + 1;
    const lcs = new Uint32Array((middleA.length + 1) * width);
    for (let i = middleA.length - 1; i >= 0; i -= 1) {
      for (let j = middleB.length - 1; j >= 0; j -= 1) {
        lcs[i * width + j] =
          middleA[i] === middleB[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < middleA.length && j < middleB.length) {
      if (middleA[i] === middleB[j]) {
        out.push({ op: 'same', line: middleA[i] });
        i += 1;
        j += 1;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        out.push({ op: 'del', line: middleA[i] });
        i += 1;
      } else {
        out.push({ op: 'add', line: middleB[j] });
        j += 1;
      }
    }
    for (; i < middleA.length; i += 1) out.push({ op: 'del', line: middleA[i] });
    for (; j < middleB.length; j += 1) out.push({ op: 'add', line: middleB[j] });
  }

  out.push(...a.slice(endA).map((line) => ({ op: 'same', line })));
  return out;
}

// Pairs a run of removed lines with the run of added lines that follows into 'change' rows.
function toRows(steps) {
  const rows = [];
  let leftNo = 0;
  let rightNo = 0;
  for (let index = 0; index < steps.length; ) {
    if (steps[index].op === 'same') {
      leftNo += 1;
      rightNo += 1;
      rows.push({ kind: 'same', left: steps[index].line, right: steps[index].line, leftNo, rightNo });
      index += 1;
      continue;
    }
    const removed = [];
    const added = [];
    while (index < steps.length && steps[index].op === 'del') removed.push(steps[index++].line);
    while (index < steps.length && steps[index].op === 'add') added.push(steps[index++].line);
    for (let k = 0; k < Math.max(removed.length, added.length); k += 1) {
      const hasLeft = k < removed.length;
      const hasRight = k < added.length;
      if (hasLeft) leftNo += 1;
      if (hasRight) rightNo += 1;
      rows.push({
        kind: hasLeft && hasRight ? 'change' : hasLeft ? 'del' : 'add',
        left: hasLeft ? removed[k] : '',
        right: hasRight ? added[k] : '',
        leftNo: hasLeft ? leftNo : null,
        rightNo: hasRight ? rightNo : null,
      });
    }
  }
  return rows;
}

// Folds runs of unchanged rows longer than twice the context into one 'skip' row.
function fold(rows) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.kind === 'same') return;
    for (let k = Math.max(0, index - CONTEXT_LINES); k <= Math.min(rows.length - 1, index + CONTEXT_LINES); k += 1) keep[k] = true;
  });
  const out = [];
  for (let index = 0; index < rows.length; ) {
    if (keep[index]) {
      out.push(rows[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && !keep[end]) end += 1;
    out.push({ kind: 'skip', left: String(end - index), right: '', leftNo: null, rightNo: null });
    index = end;
  }
  return out;
}

// original, proposed: texts. Resolves to { rows, added, removed } (line counts, blank lines included).
export function diffLines(original, proposed) {
  const rows = toRows(script(split(original), split(proposed)));
  const added = rows.filter((r) => r.kind === 'add' || r.kind === 'change').length;
  const removed = rows.filter((r) => r.kind === 'del' || r.kind === 'change').length;
  return { rows: fold(rows), added, removed };
}
