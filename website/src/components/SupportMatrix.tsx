import { engines, getSiteContent } from '../content/site';
import { useSiteLang } from '../i18n/lang';
import { Reveal } from './Reveal';

function Cell({ value }: { value: string }) {
  const lang = useSiteLang();
  const ui = getSiteContent(lang).ui.matrix;
  if (value === 'yes') {
    return (
      <span className="cell-yes" aria-label={ui.yesAria}>
        <CheckIcon />
      </span>
    );
  }
  if (value === 'no') {
    return (
      <span className="cell-no" aria-label={ui.noAria}>
        —
      </span>
    );
  }
  return <span className="cell-pill">{value}</span>;
}

export function SupportMatrix() {
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  return (
    <section className="section" id="matrix">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">{c.ui.matrix.kicker}</p>
            <h2>{c.ui.matrix.heading}</h2>
            <p className="section__sub">{c.ui.matrix.sub}</p>
          </header>
        </Reveal>
        <Reveal delay={120}>
          <div className="card matrix-wrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th scope="col" className="matrix__cap">
                    {c.ui.matrix.capability}
                  </th>
                  {engines.map((e) => (
                    <th scope="col" key={e.key}>
                      <span className="matrix__engine">
                        <img src={e.logo} alt="" width={18} height={18} />
                        {e.name}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.matrixRows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row" className="matrix__cap">
                      {row.label}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td key={engines[i]?.key ?? i}>
                        <Cell value={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="section__footnote">{c.matrixFootnote}</p>
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
