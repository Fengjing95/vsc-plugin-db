import { getSiteContent } from '../content/site';
import type { DocsArticle, DocsBlock } from '../content/site';
import { useSiteLang } from '../i18n/lang';
import { Reveal } from './Reveal';

function Block({ block }: { block: DocsBlock }) {
  if (block.kind === 'ul') {
    return (
      <ul>
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }
  if (block.kind === 'note') {
    return (
      <p className="docs__note" role="note">
        {block.text}
      </p>
    );
  }
  return <p>{block.text}</p>;
}

function Article({ article }: { article: DocsArticle }) {
  return (
    <details className="card docs__article" id={`docs-${article.id}`}>
      <summary>
        <span className="docs__article-head">
          <h3>{article.title}</h3>
          <p>{article.intro}</p>
        </span>
        <span className="docs__chevron" aria-hidden="true" />
      </summary>
      <div className="docs__body">
        {article.sections.map((s) => (
          <section key={s.h}>
            <h4>{s.h}</h4>
            {s.blocks.map((b, i) => (
              <Block key={i} block={b} />
            ))}
          </section>
        ))}
      </div>
    </details>
  );
}

export function Docs() {
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  return (
    <section className="section section--docs" id="docs">
      <div className="container">
        <Reveal>
          <header className="section__head">
            <p className="section__kicker">{c.docs.kicker}</p>
            <h2>{c.docs.heading}</h2>
            <p className="section__sub">{c.docs.sub}</p>
          </header>
        </Reveal>
        <Reveal delay={120}>
          <nav className="docs__nav" aria-label={c.docs.navAria}>
            {c.docs.articles.map((a) => (
              <a key={a.id} href={`#docs-${a.id}`}>
                {a.title}
              </a>
            ))}
          </nav>
          <div className="docs__list">
            {c.docs.articles.map((a) => (
              <Article key={a.id} article={a} />
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
