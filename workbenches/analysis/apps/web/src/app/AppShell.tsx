import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Search, Users } from "lucide-react";

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <div className="app-shell">
    <header className="masthead">
      <Link to="/" className="brand">
        <span className="brand__index">01</span>
        <span><strong>CREATOR LAB</strong><small>创作实验室</small></span>
      </Link>
      <div className="masthead__meta"><span>PRIVATE WORKSPACE</span><span className="live-dot">LOCAL</span></div>
    </header>
    <nav className="section-nav" aria-label="主导航">
      <Link className={location.pathname.startsWith("/analyze") || location.pathname.startsWith("/runs") ? "active" : ""} to="/analyze"><Search size={16}/> 单帖报告</Link>
      <Link className={location.pathname.startsWith("/creators") || location.pathname.startsWith("/creator-runs") ? "active" : ""} to="/creators"><Users size={16}/> 博主研究</Link>
    </nav>
    {children}
  </div>;
}
