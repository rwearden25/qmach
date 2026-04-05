import React, { useCallback } from 'react';
import { Link } from 'react-router-dom';

/* ------------------------------------------------------------------ */
/* Icons                                                                */
/* ------------------------------------------------------------------ */

function ShieldCheckIcon({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="#00FF88" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
      stroke="#00FF88" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
      stroke="#6366F1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
      stroke="#F59E0B" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Data                                                                 */
/* ------------------------------------------------------------------ */

const FEATURES = [
  {
    icon: <LockIcon />,
    title: 'Zero-Knowledge Encryption',
    desc: 'Every file is encrypted on your device with AES-256-GCM before it leaves. The server stores only ciphertext — even a full infrastructure breach reveals nothing.',
    color: 'border-[#00FF88]/20 hover:border-[#00FF88]/40',
    dot: 'bg-[#00FF88]',
  },
  {
    icon: <KeyIcon />,
    title: 'Multi-Factor Authentication',
    desc: 'Protect every session with TOTP authenticator apps, hardware passkeys (WebAuthn), and re-authentication for sensitive actions.',
    color: 'border-[#6366F1]/20 hover:border-[#6366F1]/40',
    dot: 'bg-[#6366F1]',
  },
  {
    icon: <CloudIcon />,
    title: 'Zero Data Loss',
    desc: 'Redundant distributed storage, automatic file versioning, and SHA-256 integrity verification protect your files from corruption or accidental deletion.',
    color: 'border-[#F59E0B]/20 hover:border-[#F59E0B]/40',
    dot: 'bg-[#F59E0B]',
  },
];

const STEPS = [
  {
    num: '01',
    title: 'Create Your Account',
    desc: 'Sign up in seconds and set your master password. Enable MFA for maximum security before uploading your first file.',
  },
  {
    num: '02',
    title: 'Upload & Encrypt',
    desc: 'Drag and drop any file. It\'s encrypted client-side with a unique key derived from your master password — before leaving your device.',
  },
  {
    num: '03',
    title: 'Access Anywhere',
    desc: 'Open, download, and share files from any device. Decryption happens locally in your browser. Only you hold the keys.',
  },
];

const BADGES = [
  'AES-256-GCM',
  'Argon2id / PBKDF2',
  'RS256 JWT',
  'Zero Server Access',
  'HKDF-SHA-256',
  'TOTP + WebAuthn',
];

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    period: '/forever',
    storage: '5 GB',
    features: [
      'End-to-end encryption',
      'Multi-factor authentication',
      'File versioning (3 versions)',
      'Community support',
    ],
    highlighted: false,
    cta: 'Get Started Free',
    ctaTo: '/register',
  },
  {
    name: 'Pro',
    price: '$9',
    period: '/month',
    storage: '100 GB',
    features: [
      'Everything in Free',
      'File versioning (10 versions)',
      'Advanced sharing controls',
      'Priority email support',
      'Audit log',
    ],
    highlighted: true,
    cta: 'Start Free Trial',
    ctaTo: '/register?plan=pro',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    storage: 'Unlimited',
    features: [
      'Everything in Pro',
      'SSO / SAML integration',
      'Unlimited file versioning',
      'Dedicated account manager',
      '99.99% uptime SLA',
    ],
    highlighted: false,
    cta: 'Contact Sales',
    ctaTo: '/contact',
  },
];

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export default function LandingPage() {
  const handleLearnMore = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <div className="min-h-dvh bg-[#0A0A0B] text-[#FAFAFA] scroll-smooth">

      {/* ---- Navbar ---- */}
      <nav
        className="fixed top-0 inset-x-0 z-50 bg-[#0A0A0B]/80 backdrop-blur-md border-b border-[#1F1F23]"
        aria-label="Primary navigation"
      >
        <div className="max-w-screen-xl mx-auto px-4 tv:px-16 h-16 tv:h-20 flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <ShieldCheckIcon size={28} />
            <span className="font-heading font-bold text-lg tv:text-2xl">SecureVault</span>
          </div>
          {/* Nav links */}
          <div className="hidden md:flex items-center gap-6 text-sm text-[#71717A]">
            <a href="#features" onClick={handleLearnMore} className="hover:text-[#FAFAFA] transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-[#FAFAFA] transition-colors">How It Works</a>
            <a href="#pricing" className="hover:text-[#FAFAFA] transition-colors">Pricing</a>
          </div>
          {/* CTAs */}
          <div className="flex items-center gap-2">
            <Link
              to="/login"
              className="text-sm text-[#71717A] hover:text-[#FAFAFA] transition-colors px-3 h-11 flex items-center rounded-input hover:bg-white/5"
            >
              Sign In
            </Link>
            <Link
              to="/register"
              className="inline-flex items-center justify-center h-11 px-5 rounded-pill bg-[#00FF88] text-[#0A0A0B] font-semibold text-sm hover:opacity-90 transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88] focus-visible:outline-offset-4"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* ---- Hero ---- */}
      <section className="relative pt-32 pb-24 tv:pt-52 tv:pb-40 px-4 text-center overflow-hidden">
        {/* Animated gradient background */}
        <div
          className="absolute inset-0 pointer-events-none"
          aria-hidden="true"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(0,255,136,0.12) 0%, transparent 70%), ' +
              'radial-gradient(ellipse 50% 40% at 80% 60%, rgba(99,102,241,0.08) 0%, transparent 70%)',
            animation: 'heroPulse 8s ease-in-out infinite alternate',
          }}
        />
        {/* Noise overlay */}
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.03]"
          aria-hidden="true"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          }}
        />

        <div className="relative max-w-4xl mx-auto">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-pill border border-[#00FF88]/20 bg-[#00FF88]/5 text-[#00FF88] text-xs font-medium mb-8 tv:text-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00FF88] animate-pulse" />
            End-to-end encrypted &bull; Open source &bull; Client-side keys
          </div>

          <h1 className="text-5xl sm:text-6xl tv:text-8xl font-heading font-bold tracking-tight leading-[1.1] mb-6 tv:mb-10">
            Your Files.{' '}
            <span className="text-[#00FF88]">Your Keys.</span>
            <br />
            Zero Knowledge.
          </h1>

          <p className="text-lg sm:text-xl tv:text-2xl text-[#71717A] max-w-2xl mx-auto mb-10 tv:mb-14 leading-relaxed">
            Encrypted cloud storage where only you can access your data.
            Not us. Not hackers. Not anyone.
          </p>

          <div className="flex flex-wrap gap-4 justify-center">
            <Link
              to="/register"
              className="inline-flex items-center justify-center h-14 tv:h-16 px-8 tv:px-12 rounded-pill bg-[#00FF88] text-[#0A0A0B] font-bold text-base tv:text-lg hover:opacity-90 active:scale-[0.98] transition-all shadow-[0_4px_24px_rgba(0,255,136,0.3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88] focus-visible:outline-offset-4"
            >
              Get Started Free
            </Link>
            <a
              href="#features"
              onClick={handleLearnMore}
              className="inline-flex items-center gap-2 justify-center h-14 tv:h-16 px-8 tv:px-12 rounded-pill border border-[#1F1F23] text-[#FAFAFA] font-medium text-base tv:text-lg hover:border-[#00FF88]/40 hover:bg-[#00FF88]/5 active:scale-[0.98] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88] focus-visible:outline-offset-4"
            >
              Learn More
              <ChevronDownIcon />
            </a>
          </div>

          {/* Social proof / trust line */}
          <p className="mt-10 tv:mt-14 text-xs text-[#71717A]">
            No credit card required &bull; Free plan forever &bull; Cancel anytime
          </p>
        </div>
      </section>

      {/* ---- Features ---- */}
      <section id="features" className="py-20 tv:py-32 px-4">
        <div className="max-w-screen-xl mx-auto">
          <div className="text-center mb-14 tv:mb-20">
            <h2 className="text-3xl tv:text-5xl font-heading font-bold mb-4">Three Core Guarantees</h2>
            <p className="text-[#71717A] max-w-xl mx-auto tv:text-lg">
              Built from the ground up with security as the foundation — not an afterthought.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 tv:gap-8">
            {FEATURES.map((f) => (
              <article
                key={f.title}
                className={[
                  'bg-[#141416] border rounded-card p-8 tv:p-10',
                  'transition-all duration-200 group relative overflow-hidden',
                  f.color,
                ].join(' ')}
              >
                {/* Glow dot top-left */}
                <div
                  className={`absolute -top-6 -left-6 w-24 h-24 rounded-full blur-3xl opacity-20 group-hover:opacity-30 transition-opacity ${f.dot}`}
                  aria-hidden="true"
                />
                <div className="w-14 h-14 tv:w-16 tv:h-16 rounded-card bg-[#0A0A0B] border border-[#1F1F23] flex items-center justify-center mb-6 relative">
                  {f.icon}
                </div>
                <h3 className="text-lg tv:text-xl font-heading font-semibold mb-3">{f.title}</h3>
                <p className="text-sm tv:text-base text-[#71717A] leading-relaxed">{f.desc}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---- How It Works ---- */}
      <section id="how-it-works" className="py-20 tv:py-32 px-4 bg-[#141416]/40">
        <div className="max-w-screen-xl mx-auto">
          <div className="text-center mb-14 tv:mb-20">
            <h2 className="text-3xl tv:text-5xl font-heading font-bold mb-4">How It Works</h2>
            <p className="text-[#71717A] max-w-xl mx-auto tv:text-lg">
              Three simple steps to private, secure file storage.
            </p>
          </div>
          <div className="relative grid grid-cols-1 md:grid-cols-3 gap-10 tv:gap-16">
            {/* Connecting line (desktop only) */}
            <div
              className="hidden md:block absolute top-8 left-[calc(33%+2rem)] right-[calc(33%+2rem)] h-px"
              aria-hidden="true"
              style={{
                background: 'linear-gradient(90deg, transparent, #1F1F23 30%, #1F1F23 70%, transparent)',
              }}
            />
            {STEPS.map((step) => (
              <div key={step.num} className="relative flex flex-col items-center text-center">
                <div className="w-16 h-16 tv:w-20 tv:h-20 rounded-full bg-[#0A0A0B] border-2 border-[#00FF88]/25 flex items-center justify-center mb-6 relative z-10 shadow-[0_0_24px_rgba(0,255,136,0.1)]">
                  <span className="font-heading font-bold text-[#00FF88] text-xl tv:text-2xl">
                    {step.num}
                  </span>
                </div>
                <h3 className="text-lg tv:text-xl font-heading font-semibold mb-3">{step.title}</h3>
                <p className="text-sm tv:text-base text-[#71717A] max-w-[260px] leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Security Badges ---- */}
      <section className="py-16 tv:py-24 px-4">
        <div className="max-w-screen-xl mx-auto text-center">
          <p className="text-xs tv:text-sm uppercase tracking-widest text-[#71717A] mb-6">
            Built on proven cryptography
          </p>
          <div className="flex flex-wrap gap-3 justify-center tv:gap-4">
            {BADGES.map((b) => (
              <span
                key={b}
                className="px-4 py-2 tv:px-5 tv:py-2.5 rounded-pill border border-[#1F1F23] text-sm tv:text-base text-[#71717A] font-mono bg-[#141416] hover:border-[#00FF88]/30 hover:text-[#FAFAFA] transition-colors"
              >
                {b}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Pricing ---- */}
      <section id="pricing" className="py-20 tv:py-32 px-4 bg-[#141416]/40">
        <div className="max-w-screen-xl mx-auto">
          <div className="text-center mb-14 tv:mb-20">
            <h2 className="text-3xl tv:text-5xl font-heading font-bold mb-4">Simple Pricing</h2>
            <p className="text-[#71717A] max-w-lg mx-auto tv:text-lg">
              Start free. Upgrade when you need more storage.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 tv:gap-8 max-w-5xl mx-auto">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={[
                  'rounded-card flex flex-col relative',
                  plan.highlighted
                    ? 'bg-[#00FF88]/[0.04] border-2 border-[#00FF88]/30 shadow-[0_0_40px_rgba(0,255,136,0.1)]'
                    : 'bg-[#141416] border border-[#1F1F23]',
                  'p-8 tv:p-10',
                ].join(' ')}
              >
                {/* Popular badge */}
                {plan.highlighted && (
                  <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-[#00FF88] text-[#0A0A0B] text-xs font-bold uppercase tracking-wider whitespace-nowrap">
                    Most Popular
                  </span>
                )}

                <div className="mb-6">
                  <h3 className="text-lg tv:text-xl font-heading font-semibold mb-2">{plan.name}</h3>
                  <div className="flex items-baseline gap-1 mb-1">
                    <span className="text-3xl tv:text-4xl font-heading font-bold">{plan.price}</span>
                    {plan.period && <span className="text-sm text-[#71717A]">{plan.period}</span>}
                  </div>
                  <p className="text-sm text-[#71717A]">{plan.storage} encrypted storage</p>
                </div>

                <ul className="space-y-3 mb-8 flex-1" aria-label={`${plan.name} features`}>
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5 text-sm tv:text-base text-[#71717A]">
                      <span className={`mt-0.5 shrink-0 ${plan.highlighted ? 'text-[#00FF88]' : 'text-[#00FF88]/70'}`}>
                        <CheckIcon />
                      </span>
                      {feature}
                    </li>
                  ))}
                </ul>

                <Link
                  to={plan.ctaTo}
                  className={[
                    'inline-flex items-center justify-center h-12 tv:h-14 rounded-input font-semibold text-sm tv:text-base',
                    'transition-all duration-150 active:scale-[0.98]',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88] focus-visible:outline-offset-4',
                    plan.highlighted
                      ? 'bg-[#00FF88] text-[#0A0A0B] hover:opacity-90 shadow-[0_4px_16px_rgba(0,255,136,0.25)]'
                      : 'border border-[#1F1F23] text-[#FAFAFA] hover:border-[#00FF88]/40 hover:bg-[#00FF88]/5',
                  ].join(' ')}
                >
                  {plan.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Final CTA ---- */}
      <section className="py-20 tv:py-32 px-4 text-center">
        <div className="max-w-2xl mx-auto">
          <div className="w-16 h-16 tv:w-20 tv:h-20 rounded-full bg-[#00FF88]/10 border border-[#00FF88]/20 flex items-center justify-center mx-auto mb-6">
            <ShieldCheckIcon size={32} />
          </div>
          <h2 className="text-3xl tv:text-5xl font-heading font-bold mb-4">
            Take control of your data.
          </h2>
          <p className="text-[#71717A] mb-8 tv:text-lg">
            Join thousands of users who trust SecureVault to keep their files private.
            No surveillance. No data mining. Just encryption.
          </p>
          <Link
            to="/register"
            className="inline-flex items-center justify-center h-14 tv:h-16 px-10 tv:px-14 rounded-pill bg-[#00FF88] text-[#0A0A0B] font-bold text-base tv:text-lg hover:opacity-90 active:scale-[0.98] transition-all shadow-[0_4px_24px_rgba(0,255,136,0.3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88] focus-visible:outline-offset-4"
          >
            Create Free Account
          </Link>
        </div>
      </section>

      {/* ---- Footer ---- */}
      <footer className="border-t border-[#1F1F23] py-12 tv:py-16 px-4">
        <div className="max-w-screen-xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 mb-8">
            <div className="flex items-center gap-2">
              <ShieldCheckIcon size={24} />
              <span className="font-heading font-bold tv:text-lg">SecureVault</span>
            </div>
            <nav className="flex flex-wrap gap-4 sm:gap-6 text-sm text-[#71717A] justify-center" aria-label="Footer navigation">
              <a href="#features" onClick={handleLearnMore} className="hover:text-[#FAFAFA] transition-colors">Features</a>
              <a href="#pricing" className="hover:text-[#FAFAFA] transition-colors">Pricing</a>
              <a href="#" className="hover:text-[#FAFAFA] transition-colors">Privacy Policy</a>
              <a href="#" className="hover:text-[#FAFAFA] transition-colors">Terms of Service</a>
              <a href="#" className="hover:text-[#FAFAFA] transition-colors">Security</a>
              <a href="#" className="hover:text-[#FAFAFA] transition-colors">About</a>
            </nav>
          </div>
          <div className="border-t border-[#1F1F23] pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-xs text-[#71717A]">
              &copy; {new Date().getFullYear()} SecureVault. All rights reserved.
            </p>
            <p className="text-xs text-[#71717A]">
              Zero-knowledge encryption &bull; Your keys, your data
            </p>
          </div>
        </div>
      </footer>

      {/* ---- Keyframe styles ---- */}
      <style>{`
        @keyframes heroPulse {
          from {
            background-position: 0% 0%;
            opacity: 0.8;
          }
          to {
            background-position: 5% 5%;
            opacity: 1;
          }
        }
        html { scroll-behavior: smooth; }
      `}</style>
    </div>
  );
}
