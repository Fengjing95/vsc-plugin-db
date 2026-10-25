import { getSiteContent, site } from '../content/site';
import { useSiteLang } from '../i18n/lang';
import { Reveal } from './Reveal';

export function ComingSoon() {
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  return (
    <section className="section" id="roadmap">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">{c.ui.comingSoon.kicker}</p>
            <h2>{c.ui.comingSoon.heading}</h2>
            <p className="section__sub">{c.ui.comingSoon.sub}</p>
          </header>
        </Reveal>
        <div className="coming__grid">
          {c.comingSoon.map((item, i) => (
            <Reveal key={item.name} delay={i * 90}>
              <article className="card coming__card">
                <div className="coming__badge">{c.ui.comingSoon.badge}</div>
                <h3>{item.name}</h3>
                <p>{item.desc}</p>
                {item.tags ? (
                  <ul className="coming__tags" aria-label={c.ui.comingSoon.candidatesAria}>
                    {item.tags.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                ) : null}
                <a
                  className="coming__link"
                  href={site.urls.newFeatureIssue}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={c.ui.comingSoon.ctaAria.replace('{0}', item.name)}
                >
                  {c.ui.comingSoon.cta} <span aria-hidden="true">→</span>
                </a>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
