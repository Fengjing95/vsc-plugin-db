import { getSiteContent, site } from '../content/site';
import { useSiteLang } from '../i18n/lang';
import { CopyCommand } from './CopyCommand';
import { Reveal } from './Reveal';

export function QuickStart() {
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  return (
    <section className="section" id="quickstart">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">{c.ui.quickStart.kicker}</p>
            <h2>{c.ui.quickStart.heading}</h2>
          </header>
        </Reveal>
        <div className="qs__grid">
          <Reveal>
            <div className="card qs__install">
              <h3>
                {c.ui.quickStart.stepLabel}
                <span>{c.ui.quickStart.installHeading}</span>
              </h3>
              <ol className="qs__install-list">
                {c.quickStart.install.map((w) => (
                  <li key={w.title}>
                    <strong>{w.title}</strong>
                    <span>{w.desc}</span>
                  </li>
                ))}
              </ol>
              <CopyCommand command={site.installCommand} />
              <a className="qs__releases" href={site.urls.releases} target="_blank" rel="noreferrer">
                {c.ui.quickStart.downloadNote} <span aria-hidden="true">→</span>
              </a>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="qs__steps">
              {c.quickStart.steps.map((s, i) => (
                <div className="qs__step" key={s.title}>
                  <span className="qs__step-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div>
                    <h3>{s.title}</h3>
                    <p>{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
