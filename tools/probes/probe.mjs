// Probe: does plain HTTP (no browser) get us Google/DDG/Bing HTML from this IP?
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const targets = [
  ["google",   "https://www.google.com/search?q=headless+chrome+test&num=20"],
  ["ddg-html", "https://html.duckduckgo.com/html/?q=headless+chrome+test"],
  ["ddg-lite", "https://lite.duckduckgo.com/lite/?q=headless+chrome+test"],
  ["bing",     "https://www.bing.com/search?q=headless+chrome+test&count=20"],
];
for (const [name, url] of targets) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": UA,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        ...(name === "bing" ? { referer: "https://www.bing.com/" } : {}),
      },
      redirect: "follow",
    });
    const html = await r.text();
    const ms = Date.now() - t0;
    const signals = {
      bytes: html.length,
      blockPage: /sorry\/index|\/sorry\/|unusual traffic|are you a robot|captcha|Verifying your request|anomaly/i.test(html),
      googleResult: /<h3/.test(html),
      ddgResult: /result__a|result-link|result__snippet/.test(html),
      bingResult: /b_algo/.test(html),
      finalUrl: r.url.slice(0, 90),
    };
    console.log(name.padEnd(10), r.status, String(ms).padStart(5)+"ms", JSON.stringify(signals));
  } catch (e) {
    console.log(name.padEnd(10), "ERR", e.message);
  }
}
