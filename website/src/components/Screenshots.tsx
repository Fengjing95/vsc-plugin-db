import { getSiteContent, withBase } from '../content/site';
import { useSiteLang } from '../i18n/lang';
import { Reveal } from './Reveal';

export function Screenshots() {
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  return (
    <section className="section" id="screenshots">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">{c.ui.screenshots.kicker}</p>
            <h2>{c.ui.screenshots.heading}</h2>
            <p className="section__sub">{c.ui.screenshots.sub}</p>
          </header>
        </Reveal>
        <div className="shots__grid">
          {c.screenshots.map((s, i) => (
            <Reveal key={s.file} delay={(i % 2) * 90}>
              <figure className="shot">
                <div className="shot__bar" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <span>{s.title}</span>
                </div>
                <img
                  src={withBase(`assets/images/${s.file}`)}
                  alt={c.ui.screenshots.alt.replace('{0}', s.title)}
                  width={1600}
                  height={1000}
                  loading="lazy"
                  decoding="async"
                />
                <figcaption className="shot__caption">
                  <strong>{s.title}</strong>
                  <span>{s.desc}</span>
                </figcaption>
              </figure>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
