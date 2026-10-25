import { getSiteContent } from '../content/site';
import { useSiteLang } from '../i18n/lang';
import { Reveal } from './Reveal';
import { SpotlightCard } from './fx/SpotlightCard';

export function Features() {
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  return (
    <section className="section" id="features">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">{c.ui.features.kicker}</p>
            <h2>{c.ui.features.heading}</h2>
            <p className="section__sub">{c.ui.features.sub}</p>
          </header>
        </Reveal>
        <div className="features__grid">
          {c.features.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 90}>
              <SpotlightCard className="card feature">
                <span className="feature__icon" aria-hidden="true">
                  {f.icon}
                </span>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </SpotlightCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
