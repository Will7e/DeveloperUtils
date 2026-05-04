import { useEffect } from 'react';

/**
 * Keeps the Vercel deployment warm by pinging the status endpoint
 * every 4 minutes while the application is active in a browser tab.
 */
export const useKeepAlive = () => {
  useEffect(() => {
    // Ping immediately on mount
    const ping = () => {
      fetch('/status.json', { cache: 'no-store' }).catch(() => {
        // Silently fail if offline or error
      });
    };

    ping();

    // Set up interval (4 minutes is safe for Vercel's timeout windows)
    const interval = setInterval(ping, 4 * 60 * 1000);

    return () => clearInterval(interval);
  }, []);
};
