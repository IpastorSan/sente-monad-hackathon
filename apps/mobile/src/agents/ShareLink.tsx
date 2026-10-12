/**
 * Share an agent's public page (SEN-193). On the web it copies the link — the
 * async clipboard, then a hidden textarea and `execCommand('copy')` for a
 * browser or an insecure origin without it, then a prompt the reader can copy
 * from. On a phone it opens the system share sheet (React Native's own
 * `Share`, no native module of ours).
 */
import { useEffect, useRef, useState } from 'react';
import { Platform, Share } from 'react-native';

import { Button } from '@/ui/kit';

import { publicAgentUrl } from './publicAgent';

async function copyOnWeb(url: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch {
    // Refused (permissions, an insecure origin): try the older path.
  }
  try {
    const area = document.createElement('textarea');
    area.value = url;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    if (ok) return true;
  } catch {
    // Fall through to the prompt.
  }
  window.prompt('Copy this link', url);
  return false;
}

export function ShareLinkButton({
  agentId,
  agentName,
  label = 'Share',
  kind = 'secondary',
}: {
  agentId: string;
  agentName: string;
  label?: string;
  kind?: 'secondary' | 'soft';
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const share = async () => {
    const url = publicAgentUrl(agentId);
    if (Platform.OS !== 'web') {
      await Share.share({ message: `${agentName} on Sente: ${url}`, url }).catch(() => undefined);
      return;
    }
    if (await copyOnWeb(url)) {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <Button
      label={copied ? 'Link copied' : label}
      kind={kind}
      size="sm"
      icon={copied ? 'check' : 'share'}
      onPress={() => void share()}
    />
  );
}
