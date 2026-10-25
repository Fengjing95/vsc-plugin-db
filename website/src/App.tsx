import { useEffect } from 'react';
import { Nav } from './components/Nav';
import { Hero } from './components/Hero';
import { SupportMatrix } from './components/SupportMatrix';
import { Features } from './components/Features';
import { Screenshots } from './components/Screenshots';
import { ComingSoon } from './components/ComingSoon';
import { QuickStart } from './components/QuickStart';
import { Footer } from './components/Footer';
import { useSiteLang } from './i18n/lang';
import { getSiteContent } from './content/site';

export default function App() {
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  // 语言切换时同步 SEO 基本面：<title> 与 meta description（og/twitter 标签为静态构建产物，客户端不动）
  useEffect(() => {
    const content = getSiteContent(lang);
    document.title = content.meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', content.meta.description);
  }, [lang]);

  return (
    <>
      <a className="skip-link" href="#main">
        {c.ui.skipToContent}
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <SupportMatrix />
        <Features />
        <Screenshots />
        <ComingSoon />
        <QuickStart />
      </main>
      <Footer />
    </>
  );
}
