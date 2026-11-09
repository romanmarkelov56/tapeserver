import fetch from 'node-fetch';

export class SoundCloudClientIdResolver {
  private clientId: string | null;
  private inFlightPromise: Promise<string> | null = null;

  constructor(initialClientId?: string) {
    this.clientId = initialClientId || null;
  }

  public async getClientId(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.clientId) {
      return this.clientId;
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        const response = await fetch('https://soundcloud.com', {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
        const html = await response.text();

        // Find all script tags referencing sndcdn.com
        const scriptRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/g;
        const scriptUrls: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = scriptRegex.exec(html)) !== null) {
          const src = match[1];
          if (src.includes('sndcdn.com') && src.endsWith('.js')) {
            scriptUrls.push(src);
          }
        }

        // Search scripts from the end backwards for client_id regex
        for (let i = scriptUrls.length - 1; i >= 0; i--) {
          try {
            const scriptRes = await fetch(scriptUrls[i]);
            const scriptText = await scriptRes.text();
            const clientIdMatch = scriptText.match(/client_id\s*:\s*["']([a-zA-Z0-9]{32})["']/);
            if (clientIdMatch && clientIdMatch[1]) {
              this.clientId = clientIdMatch[1];
              return this.clientId;
            }
          } catch {
            // Ignore individual fetch errors and continue
          }
        }

        // Fallback: direct match in main page HTML
        const htmlClientIdMatch = html.match(/client_id\s*:\s*["']([a-zA-Z0-9]{32})["']/);
        if (htmlClientIdMatch && htmlClientIdMatch[1]) {
          this.clientId = htmlClientIdMatch[1];
          return this.clientId;
        }

        throw new Error('Unable to resolve SoundCloud client_id');
      } finally {
        this.inFlightPromise = null;
      }
    })();

    return this.inFlightPromise;
  }

  public async refreshClientId(): Promise<string> {
    return this.getClientId(true);
  }
}
