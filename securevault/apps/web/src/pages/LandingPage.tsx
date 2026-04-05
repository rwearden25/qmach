import React from 'react';
import { Link } from 'react-router-dom';

/* ─── Icons ────────────────────────────────────────────────────────────────── */

function ShieldCheckIcon() {
  return <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00FF88" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>;
}
function LockIcon() {
  return <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00FF88" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
}
function KeyIcon() {
  return <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366F1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>;
}
function DatabaseIcon() {
  return <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
}
function CheckIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
}

const FEATURES = [
  { icon: <LockIcon />, title: 'Zero-Knowledge Encryption', desc: 'Files are encrypted on your device before upload. The server never sees your data — even a full breach exposes nothing.' },
  { icon: <KeyIcon />, title: 'Multi-Factor Authentication', desc: 'Every account is protected by TOTP and optional hardware keys. No session without second factor verification.' },
  { icon: <DatabaseIcon />, title: 'Zero Data Loss', desc: 'Redundant storage, file versioning, and continuous integrity monitoring ensure your files are never lost or corrupted.' },
];

const STEPS = [
  { num: '01', title: 'Create Account', desc: 'Sign up and set up multi-factor authentication with your authenticator app.' },
  { num: '02', title: 'Upload Files', desc: 'Files are encrypted client-side with AES-256-GCM before they ever leave your device.' },
  { num: '03', title: 'Access Anywhere', desc: 'Download and decrypt your files on any device. Only you hold the keys.' },
];

const BADGES = ['AES-256-GCM', 'PBKDF2 / Argon2id', 'RS256 JWT', 'Zero Server Access', 'HKDF-SHA256', 'TOTP + WebAuthn'];

const PLANS = [
  { name: 'Free', price: '$0', period: '/forever', storage: '5 GB', features: ['End-to-end encryption', 'Multi-factor auth', 'File versioning (3)', 'Community support'], highlighted: false, cta: 'Get Started' },
  { name: 'Pro', price: '$9', period: '/month', storage: '100 GB', features: ['Everything in Free', 'File versioning (10)', 'Advanced sharing', 'Priority support', 'Audit logs'], highlighted: true, cta: 'Start Free Trial' },
  { name: 'Enterprise', price: 'Custom', period: '', storage: 'Unlimited', features: ['Everything in Pro', 'SSO integration', 'Unlimited versioning', 'Dedicated support', '99.99% SLA'], highlighted: false, cta: 'Contact Sales' },
];

export default function LandingPage() {
  return (
    <div className="min-h-dvh bg-[#0A0A0B] text-[#FAFAFA]">
      {/* ─── Nav ─────────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 inset-x-0 z-50 bg-[#0A0A0B]/80 backdrop-blur-md border-b border-[#1F1F23]" style={{ backgroundColor: 'rgba(10,10,11,0.8)' }}>
        <div className="max-w-screen-xl mx-auto px-4 tv:px-16 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon />
            <span className="font-heading font-bold text-lg">SecureVault</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/login" className="text-sm text-[#71717A] hover:text-[#FAFAFA] transition-colors px-3 py-2 min-h-[44px] flex items-center">Sign In</Link>
            <Link to="/register" className="inline-flex items-center justify-center h-10 px-5 rounded-pill bg-[#00FF88] text-[#0A0A0B] font-semibold text-sm hover:opacity-90 transition-opacity">Get Started</Link>
          </div>
        </div>
      </nav>

      {/* ─── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative pt-32 pb-20 tv:pt-48 tv:pb-32 px-4 text-center overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-[#00FF88]/5 via-transparent to-transparent pointer-events-none" />
        <div className="relative max-w-3xl mx-auto">
          <h1 className="text-4xl sm:text-5xl tv:text-7xl font-heading font-bold tracking-tight leading-tight mb-6">
            Your Files. Your Keys.{' '}
            <span className="text-[#00FF88]">Zero Knowledge.</span>
          </h1>
          <p className="text-lg tv:text-xl text-[#71717A] max-w-xl mx-auto mb-10">
            End-to-end encrypted cloud storage where only you can access your data. Not us, not hackers, not anyone.
          </p>
          <div className="flex flex-wrap gap-4 justify-center">
            <Link to="/register" className="inline-flex items-center justify-center h-14 tv:h-16 px-8 rounded-pill bg-[#00FF88] text-[#0A0A0B] font-bold text-base tv:text-lg hover:opacity-90 transition-opacity shadow-[0_4px_24px_rgba(0,255,136,0.3)]">
              Get Started Free
            </Link>
            <a href="#features" className="inline-flex items-center justify-center h-14 tv:h-16 px-8 rounded-pill border border-[#1F1F23] text-[#FAFAFA] font-medium text-base hover:border-[#00FF88] hover:bg-[#00FF88]/5 transition-all">
              Learn More
            </a>
          </div>
        </div>
      </section>

      {/* ─── Features ────────────────────────────────────────────────────── */}
      <section id="features" className="py-20 tv:py-32 px-4">
        <div className="max-w-screen-xl mx-auto">
          <h2 className="text-3xl tv:text-4xl font-heading font-bold text-center mb-4">Three Guarantees</h2>
          <p className="text-[#71717A] text-center mb-12 max-w-lg mx-auto">Built from the ground up with security as the foundation, not an afterthought.</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {FEATURES.map((f) => (
              <div key={f.title} className="bg-[#141416] border border-[#1F1F23] rounded-card p-8 tv:p-10 hover:border-[#00FF88]/20 transition-colors">
                <div className="w-14 h-14 rounded-card bg-[#0A0A0B] border border-[#1F1F23] flex items-center justify-center mb-5">{f.icon}</div>
                <h3 className="text-lg tv:text-xl font-heading font-semibold mb-3">{f.title}</h3>
                <p className="text-sm tv:text-base text-[#71717A] leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── How It Works ────────────────────────────────────────────────── */}
      <section className="py-20 tv:py-32 px-4 bg-[#141416]/50">
        <div className="max-w-screen-xl mx-auto">
          <h2 className="text-3xl tv:text-4xl font-heading font-bold text-center mb-12">How It Works</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative">
            {/* Connecting line */}
            <div className="hidden md:block absolute top-10 left-1/6 right-1/6 h-px bg-gradient-to-r from-transparent via-[#1F1F23] to-transparent" />
            {STEPS.map((s) => (
              <div key={s.num} className="text-center relative">
                <div className="w-16 h-16 tv:w-20 tv:h-20 rounded-full bg-[#0A0A0B] border-2 border-[#00FF88]/30 flex items-center justify-center mx-auto mb-5 relative z-10">
                  <span className="text-[#00FF88] font-heading font-bold text-lg tv:text-xl">{s.num}</span>
                </div>
                <h3 className="text-lg font-heading font-semibold mb-2">{s.title}</h3>
                <p className="text-sm text-[#71717A] max-w-xs mx-auto">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Security Badges ─────────────────────────────────────────────── */}
      <section className="py-16 px-4">
        <div className="max-w-screen-xl mx-auto text-center">
          <h2 className="text-2xl font-heading font-bold mb-8">Built on Proven Cryptography</h2>
          <div className="flex flex-wrap gap-3 justify-center">
            {BADGES.map((b) => (
              <span key={b} className="px-4 py-2 rounded-pill border border-[#1F1F23] text-sm text-[#71717A] font-mono bg-[#141416] hover:border-[#00FF88]/30 hover:text-[#FAFAFA] transition-colors">{b}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Pricing ─────────────────────────────────────────────────────── */}
      <section id="pricing" className="py-20 tv:py-32 px-4">
        <div className="max-w-screen-xl mx-auto">
          <h2 className="text-3xl tv:text-4xl font-heading font-bold text-center mb-4">Simple Pricing</h2>
          <p className="text-[#71717A] text-center mb-12 max-w-lg mx-auto">Start free. Upgrade when you need more space.</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {PLANS.map((p) => (
              <div key={p.name} className={`rounded-card p-8 tv:p-10 flex flex-col ${
                p.highlighted ? 'bg-[#00FF88]/5 border-2 border-[#00FF88]/30 relative' : 'bg-[#141416] border border-[#1F1F23]'
              }`}>
                {p.highlighted && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-pill bg-[#00FF88] text-[#0A0A0B] text-xs font-bold uppercase tracking-wider">Popular</span>
                )}
                <h3 className="text-lg font-heading font-semibold mb-1">{p.name}</h3>
                <div className="mb-1">
                  <span className="text-3xl font-heading font-bold">{p.price}</span>
                  <span className="text-sm text-[#71717A]">{p.period}</span>
                </div>
                <p className="text-sm text-[#71717A] mb-6">{p.storage} storage</p>
                <ul className="space-y-3 mb-8 flex-1">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-[#71717A]">
                      <span className="text-[#00FF88] mt-0.5 shrink-0"><CheckIcon /></span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link to="/register" className={`inline-flex items-center justify-center h-12 rounded-input font-semibold text-sm transition-all ${
                  p.highlighted ? 'bg-[#00FF88] text-[#0A0A0B] hover:opacity-90' : 'border border-[#1F1F23] text-[#FAFAFA] hover:border-[#00FF88] hover:bg-[#00FF88]/5'
                }`}>
                  {p.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t border-[#1F1F23] py-12 px-4">
        <div className="max-w-screen-xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon />
            <span className="font-heading font-bold">SecureVault</span>
          </div>
          <div className="flex gap-6 text-sm text-[#71717A]">
            <a href="#" className="hover:text-[#FAFAFA] transition-colors">Privacy</a>
            <a href="#" className="hover:text-[#FAFAFA] transition-colors">Terms</a>
            <a href="#" className="hover:text-[#FAFAFA] transition-colors">Security</a>
            <a href="#" className="hover:text-[#FAFAFA] transition-colors">About</a>
          </div>
          <p className="text-xs text-[#71717A]">&copy; {new Date().getFullYear()} SecureVault. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
