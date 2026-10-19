import { useEffect, useState } from 'react';

/** Absence of an offline signal counts as online, as jsdom reports. */
function readOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** Tracks `navigator.onLine` so the page can pause network-only actions. */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(readOnline);

  useEffect(() => {
    const update = () => setOnline(readOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}
