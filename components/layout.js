const style = document.createElement('style');
style.textContent = `
  body { display: flex; flex-direction: column; min-height: 100vh; }
  #site-nav {
    flex-shrink: 0;
    background: white;
    border-bottom: 1px solid #e2e8f0;
    padding: 0 24px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  #site-nav .nav-logo { font-size: 0.95rem; font-weight: 700; color: #0f172a; text-decoration: none; }
  #site-nav .nav-links { display: flex; gap: 20px; }
  #site-nav .nav-links a { font-size: 0.85rem; color: #64748b; text-decoration: none; }
  #site-nav .nav-links a:hover { color: #2563EB; }
  .container { flex: 1; }
  #site-footer {
    flex-shrink: 0;
    text-align: center;
    padding: 16px 24px;
    border-top: 1px solid #e2e8f0;
    background: #f1f5f9;
    font-size: 0.8rem;
  }
  #site-footer a { color: #94a3b8; text-decoration: none; }
  #site-footer a:hover { color: #64748b; text-decoration: underline; }
`;
document.head.appendChild(style);

const nav = document.createElement('nav');
nav.id = 'site-nav';
nav.innerHTML = `
  <a href="/" class="nav-logo">HWP 온라인 편집기</a>
  <div class="nav-links">
    <a href="/guide/">사용 가이드</a>
    <a href="/faq/">자주 묻는 질문</a>
    <a href="/about/">서비스 소개</a>
  </div>
`;
document.body.prepend(nav);

const footer = document.createElement('footer');
footer.id = 'site-footer';
footer.innerHTML = '<a href="/privacy/">개인정보처리방침</a>';
document.body.appendChild(footer);
