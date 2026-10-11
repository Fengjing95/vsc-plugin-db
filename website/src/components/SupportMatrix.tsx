import { engines, matrixFootnote, matrixRows } from '../content/site';
import { Reveal } from './Reveal';

function Cell({ value }: { value: string }) {
  if (value === 'yes') {
    return (
      <span className="cell-yes" aria-label="支持">
        <CheckIcon />
      </span>
    );
  }
  if (value === 'no') {
    return (
      <span className="cell-no" aria-label="不支持">
        —
      </span>
    );
  }
  return <span className="cell-pill">{value}</span>;
}

export function SupportMatrix() {
  return (
    <section className="section" id="matrix">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">支持矩阵</p>
            <h2>六引擎，一套体验</h2>
            <p className="section__sub">
              MySQL · PostgreSQL · SQLite · MongoDB · Redis 五类外部数据源 + 内置 Mock
              演示源；逐格口径与扩展详情页的支持矩阵一致，不夸大。
            </p>
          </header>
        </Reveal>
        <Reveal delay={120}>
          <div className="card matrix-wrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th scope="col" className="matrix__cap">
                    能力
                  </th>
                  {engines.map((e) => (
                    <th scope="col" key={e.key}>
                      <span className="matrix__engine">
                        {e.logo ? <img src={e.logo} alt="" width={18} height={18} /> : <span aria-hidden="true">{e.emoji}</span>}
                        {e.name}
                        {e.note ? <em className="matrix__engine-note">{e.note}</em> : null}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrixRows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row" className="matrix__cap">
                      {row.label}
                    </th>
                    {row.cells.map((c, i) => (
                      <td key={engines[i]?.key ?? i}>
                        <Cell value={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="section__footnote">{matrixFootnote}</p>
        </Reveal>
      </div>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="rgba(52, 211, 153, 0.12)" />
      <path d="M6 10.2l2.6 2.6L14 7.4" stroke="#34d399" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
