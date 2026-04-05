import React, { useState, useCallback, useRef } from 'react';
import { Modal } from '../shared/Modal';
import { Button } from '../shared/Button';
import { apiClient } from '../../lib/api';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type AccessLevel = 'view' | 'download';

export interface ShareConfig {
  email: string;
  accessLevel: AccessLevel;
  expiresAt: string;     // ISO date string or ''
  maxAccesses: number | '';
}

interface ShareResponse {
  shareLink: string;
  shareId: string;
}

export interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  fileId: string;
  fileName: string;
}

/* ------------------------------------------------------------------ */
/* Icons                                                                */
/* ------------------------------------------------------------------ */

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function getTomorrowDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export function ShareModal({ open, onClose, fileId, fileName }: ShareModalProps) {
  const [config, setConfig] = useState<ShareConfig>({
    email: '',
    accessLevel: 'view',
    expiresAt: '',
    maxAccesses: '',
  });
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);

  const update = useCallback(<K extends keyof ShareConfig>(key: K, value: ShareConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setShareLink(null);
    setError(null);
  }, []);

  const handleGenerate = useCallback(async () => {
    setIsGenerating(true);
    setError(null);
    setShareLink(null);

    try {
      const body: Record<string, unknown> = {
        fileId,
        accessLevel: config.accessLevel,
      };
      if (config.email.trim()) body.email = config.email.trim();
      if (config.expiresAt) body.expiresAt = new Date(config.expiresAt).toISOString();
      if (config.maxAccesses !== '') body.maxAccesses = Number(config.maxAccesses);

      const data = await apiClient.post<ShareResponse>('/vault/shares', body);
      setShareLink(data.shareLink);

      // Auto-select the link for easy copying
      requestAnimationFrame(() => linkInputRef.current?.select());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate share link');
    } finally {
      setIsGenerating(false);
    }
  }, [fileId, config]);

  const handleCopy = useCallback(async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback: select the input text
      linkInputRef.current?.select();
    }
  }, [shareLink]);

  const handleClose = useCallback(() => {
    // Reset state on close
    setConfig({ email: '', accessLevel: 'view', expiresAt: '', maxAccesses: '' });
    setShareLink(null);
    setError(null);
    setCopied(false);
    onClose();
  }, [onClose]);

  return (
    <Modal open={open} onClose={handleClose} title="Share File" size="md">
      <div className="space-y-5">
        {/* File name */}
        <div className="flex items-center gap-2 p-3 rounded-input bg-[#0A0A0B] border border-[#1F1F23]">
          <LinkIcon />
          <span className="text-sm text-[#FAFAFA] truncate font-medium">{fileName}</span>
        </div>

        {/* Email input (optional) */}
        <div>
          <label htmlFor="share-email" className="block text-sm font-medium text-[#FAFAFA] mb-1.5">
            Share with (optional)
          </label>
          <input
            id="share-email"
            type="email"
            value={config.email}
            onChange={(e) => update('email', e.target.value)}
            placeholder="recipient@example.com"
            autoComplete="email"
            className={[
              'w-full h-11 px-4 rounded-input text-sm',
              'bg-[#0A0A0B] border border-[#1F1F23] text-[#FAFAFA] placeholder-[#71717A]',
              'focus:outline-none focus:border-[#00FF88] focus:ring-1 focus:ring-[#00FF88]',
              'transition-colors duration-150',
            ].join(' ')}
          />
          <p className="mt-1 text-xs text-[#71717A]">
            Leave blank to generate a public link.
          </p>
        </div>

        {/* Access level */}
        <div>
          <fieldset>
            <legend className="text-sm font-medium text-[#FAFAFA] mb-2">Access level</legend>
            <div className="flex gap-3">
              {(['view', 'download'] as AccessLevel[]).map((level) => (
                <label
                  key={level}
                  className={[
                    'flex-1 flex items-center gap-3 p-3 rounded-input border cursor-pointer',
                    'transition-colors duration-100',
                    config.accessLevel === level
                      ? 'border-[#00FF88] bg-[#00FF88]/5'
                      : 'border-[#1F1F23] hover:border-[#2A2A30]',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="access-level"
                    value={level}
                    checked={config.accessLevel === level}
                    onChange={() => update('accessLevel', level)}
                    className="sr-only"
                  />
                  <div className={[
                    'w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0',
                    config.accessLevel === level ? 'border-[#00FF88]' : 'border-[#1F1F23]',
                  ].join(' ')} aria-hidden="true">
                    {config.accessLevel === level && (
                      <div className="w-2 h-2 rounded-full bg-[#00FF88]" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[#FAFAFA] capitalize">{level}</p>
                    <p className="text-xs text-[#71717A]">
                      {level === 'view' ? 'Preview only, no download' : 'Can download the file'}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        {/* Expiration + max accesses row */}
        <div className="grid grid-cols-1 tablet:grid-cols-2 gap-4">
          {/* Expiration */}
          <div>
            <label htmlFor="share-expires" className="block text-sm font-medium text-[#FAFAFA] mb-1.5">
              Expires (optional)
            </label>
            <input
              id="share-expires"
              type="date"
              value={config.expiresAt}
              min={getTomorrowDate()}
              onChange={(e) => update('expiresAt', e.target.value)}
              className={[
                'w-full h-11 px-4 rounded-input text-sm',
                'bg-[#0A0A0B] border border-[#1F1F23] text-[#FAFAFA]',
                'focus:outline-none focus:border-[#00FF88] focus:ring-1 focus:ring-[#00FF88]',
                'transition-colors duration-150',
                '[color-scheme:dark]',
              ].join(' ')}
            />
          </div>

          {/* Max accesses */}
          <div>
            <label htmlFor="share-max-accesses" className="block text-sm font-medium text-[#FAFAFA] mb-1.5">
              Max views (optional)
            </label>
            <input
              id="share-max-accesses"
              type="number"
              min={1}
              max={9999}
              value={config.maxAccesses}
              onChange={(e) => {
                const v = e.target.value;
                update('maxAccesses', v === '' ? '' : Math.max(1, parseInt(v, 10)));
              }}
              placeholder="Unlimited"
              className={[
                'w-full h-11 px-4 rounded-input text-sm',
                'bg-[#0A0A0B] border border-[#1F1F23] text-[#FAFAFA] placeholder-[#71717A]',
                'focus:outline-none focus:border-[#00FF88] focus:ring-1 focus:ring-[#00FF88]',
                'transition-colors duration-150',
              ].join(' ')}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <p className="text-sm text-[#EF4444] bg-[#EF4444]/10 border border-[#EF4444]/20 rounded-input px-3 py-2">
            {error}
          </p>
        )}

        {/* Generate button */}
        {!shareLink && (
          <Button
            variant="primary"
            fullWidth
            loading={isGenerating}
            onClick={handleGenerate}
            className="!rounded-input"
          >
            Generate Share Link
          </Button>
        )}

        {/* Share link */}
        {shareLink && (
          <div className="space-y-2 animate-slide-up">
            <label htmlFor="share-link-value" className="block text-sm font-medium text-[#FAFAFA]">
              Share link
            </label>
            <div className="flex gap-2">
              <input
                ref={linkInputRef}
                id="share-link-value"
                type="url"
                value={shareLink}
                readOnly
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className={[
                  'flex-1 h-11 px-4 rounded-input text-sm font-mono',
                  'bg-[#0A0A0B] border border-[#00FF88]/30 text-[#FAFAFA]',
                  'focus:outline-none focus:border-[#00FF88]',
                  'select-all',
                ].join(' ')}
                aria-label="Generated share link"
              />
              <button
                type="button"
                onClick={handleCopy}
                className={[
                  'flex items-center gap-2 h-11 px-4 rounded-input text-sm font-medium shrink-0',
                  'border transition-all duration-150',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
                  copied
                    ? 'bg-[#00FF88]/15 border-[#00FF88]/30 text-[#00FF88]'
                    : 'bg-[#1F1F23] border-[#1F1F23] text-[#FAFAFA] hover:bg-[#2A2A30]',
                ].join(' ')}
                aria-label={copied ? 'Link copied' : 'Copy share link'}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                <span>{copied ? 'Copied!' : 'Copy'}</span>
              </button>
            </div>

            {/* Regenerate */}
            <button
              type="button"
              onClick={handleGenerate}
              className="text-xs text-[#71717A] hover:text-[#FAFAFA] underline transition-colors duration-100"
            >
              Generate new link
            </button>
          </div>
        )}

        {/* E2E note */}
        <div className="flex items-start gap-2 p-3 rounded-input bg-[#6366F1]/10 border border-[#6366F1]/20">
          <LockIcon />
          <p className="text-xs text-[#71717A] leading-relaxed">
            <span className="text-[#FAFAFA] font-medium">End-to-end encrypted.</span>{' '}
            Files are decrypted client-side. Your encryption key is never shared with the server or the recipient.
          </p>
        </div>
      </div>
    </Modal>
  );
}

export default ShareModal;
