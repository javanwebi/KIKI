import React from 'react';

/**
 * Parses and renders rich engineering consultant text including:
 * - Markdown tables (| ... |) with tabular numerals
 * - Industrial standard codes (DIN, ISO, HTD, SPZ, SPA, SPB, SPC)
 * - Formulas and mathematical calculations
 * - Clean headings (###, ##) and bullet lists
 */
export function renderEngineeringMarkdown(text: string, isDarkTheme = false): React.ReactNode {
  if (!text) return null;

  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let tableBuffer: string[] = [];
  let inTable = false;

  const flushTable = (keyPrefix: string) => {
    if (tableBuffer.length < 2) {
      tableBuffer.forEach((tblLine, idx) => {
        elements.push(
          <p key={`${keyPrefix}-raw-${idx}`} className="my-1 text-sm leading-relaxed">
            {formatInlineText(tblLine, isDarkTheme)}
          </p>
        );
      });
      tableBuffer = [];
      inTable = false;
      return;
    }

    const headerLine = tableBuffer[0];
    const dataLines = tableBuffer.slice(2);

    const parseRow = (line: string) =>
      line
        .split('|')
        .slice(1, -1)
        .map(cell => cell.trim());

    const headers = parseRow(headerLine);
    const rows = dataLines.map(parseRow);

    elements.push(
      <div
        key={`${keyPrefix}-tbl`}
        className={`my-3 overflow-x-auto rounded-xl border ${
          isDarkTheme ? 'border-slate-700 bg-slate-900/80' : 'border-[#E2E6EC] bg-[#FFFFFF]'
        }`}
        dir="rtl"
      >
        <table className="w-full text-right text-xs border-collapse tabular-nums">
          <thead>
            <tr
              className={
                isDarkTheme
                  ? 'bg-slate-800/90 text-orange-400 border-b border-slate-700'
                  : 'bg-[#F5F7FA] text-[#1F242D] border-b border-[#E2E6EC]'
              }
            >
              {headers.map((h, i) => (
                <th key={i} className="px-3.5 py-2.5 font-bold text-[11px] whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody
            className={`divide-y ${
              isDarkTheme ? 'divide-slate-800 text-slate-200' : 'divide-[#EEF1F5] text-[#2B313A]'
            }`}
          >
            {rows.map((row, rIdx) => (
              <tr
                key={rIdx}
                className={
                  isDarkTheme
                    ? 'hover:bg-slate-800/40 transition-colors'
                    : 'hover:bg-[#FAFBFD] transition-colors'
                }
              >
                {row.map((cell, cIdx) => (
                  <td key={cIdx} className="px-3.5 py-2.5 text-xs font-medium">
                    {formatInlineText(cell, isDarkTheme)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

    tableBuffer = [];
    inTable = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('|') && line.endsWith('|')) {
      inTable = true;
      tableBuffer.push(line);
      continue;
    } else if (inTable) {
      flushTable(`table-${i}`);
    }

    if (!line) {
      elements.push(<div key={`spacer-${i}`} className="h-1.5" />);
      continue;
    }

    if (line.startsWith('###')) {
      elements.push(
        <h4
          key={`h3-${i}`}
          className={`font-extrabold text-[13px] sm:text-sm mt-3.5 mb-1.5 pb-1 border-b ${
            isDarkTheme
              ? 'text-orange-400 border-slate-800'
              : 'text-[#C95210] border-[#F0F2F5]'
          }`}
        >
          {formatInlineText(line.replace(/^###\s*/, ''), isDarkTheme)}
        </h4>
      );
      continue;
    }

    if (line.startsWith('##')) {
      elements.push(
        <h3
          key={`h2-${i}`}
          className={`font-black text-sm sm:text-base mt-4 mb-2 ${
            isDarkTheme ? 'text-white' : 'text-[#181C22]'
          }`}
        >
          {formatInlineText(line.replace(/^##\s*/, ''), isDarkTheme)}
        </h3>
      );
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <div key={`bullet-${i}`} className="flex items-start gap-2.5 my-1 pr-1 text-[13px] sm:text-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-[#E06518]/80 mt-2 shrink-0" />
          <span className="leading-relaxed">
            {formatInlineText(line.replace(/^[-*]\s*/, ''), isDarkTheme)}
          </span>
        </div>
      );
      continue;
    }

    const numMatch = line.match(/^(\d+)[.)]\s*(.*)$/);
    if (numMatch) {
      elements.push(
        <div key={`num-${i}`} className="flex items-start gap-2 my-1.5 pr-1 text-[13px] sm:text-sm">
          <span
            className={`font-mono tabular-nums font-bold text-xs shrink-0 mt-0.5 ${
              isDarkTheme ? 'text-orange-400' : 'text-[#C95210]'
            }`}
          >
            {numMatch[1]}.
          </span>
          <span className="leading-relaxed">{formatInlineText(numMatch[2], isDarkTheme)}</span>
        </div>
      );
      continue;
    }

    if (line.startsWith('$$') || line.includes('L_p') || line.includes('approx') || line.includes('\\frac')) {
      elements.push(
        <div
          key={`formula-${i}`}
          className={`my-2.5 px-4 py-2.5 rounded-xl font-mono tabular-nums text-xs sm:text-sm text-center border ${
            isDarkTheme
              ? 'bg-slate-950/80 border-slate-700 text-amber-300'
              : 'bg-[#F7F8FA] border-[#DCE1E7] text-[#1F242D]'
          }`}
          dir="ltr"
        >
          {line.replace(/\$\$/g, '')}
        </div>
      );
      continue;
    }

    elements.push(
      <p key={`p-${i}`} className="my-1.5 text-[13px] sm:text-sm leading-[1.75]">
        {formatInlineText(line, isDarkTheme)}
      </p>
    );
  }

  if (inTable) {
    flushTable('table-end');
  }

  return <div className="space-y-0.5">{elements}</div>;
}

/**
 * Highlights bold text and standard engineering codes cleanly without pill clutter
 */
function formatInlineText(text: string, isDarkTheme: boolean): React.ReactNode {
  if (!text) return '';

  const parts = text.split(/(\*\*[^*]+\*\*)/g);

  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      const boldContent = part.slice(2, -2);
      const isStandardCode = /DIN|ISO|HTD|SPZ|SPA|SPB|SPC|PK|PJ|SWR|FORZA/i.test(boldContent);

      return (
        <strong
          key={idx}
          className={`font-bold ${
            isStandardCode
              ? isDarkTheme
                ? 'text-orange-400 font-mono'
                : 'text-[#C95210] font-mono'
              : isDarkTheme
              ? 'text-white'
              : 'text-[#181C22]'
          }`}
        >
          {boldContent}
        </strong>
      );
    }

    const stdRegex = /\b(DIN\s*\d+|ISO\s*\d+|HTD\s*\d*[M]?|SPZ|SPA|SPB|SPC|8M|14M|5M|3M|PK|PJ|SWR|FORZA)\b/gi;
    if (stdRegex.test(part)) {
      const subParts = part.split(stdRegex);
      return subParts.map((sub, sIdx) => {
        if (stdRegex.test(sub)) {
          return (
            <span
              key={`${idx}-${sIdx}`}
              dir="ltr"
              className={`inline-block font-mono font-bold text-[0.92em] mx-0.5 ${
                isDarkTheme ? 'text-orange-300' : 'text-[#C95210]'
              }`}
            >
              {sub}
            </span>
          );
        }
        return sub;
      });
    }

    return part;
  });
}
