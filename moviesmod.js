// moviesmod.js
// MoviesMod - Hindi/English movies & series provider (Stremio Addon)
// Flow: TMDB title → search moviesmod.army → parse download page → resolve modpro/driveseed chain → final MP4/MKV URL

const cheerio = require('cheerio-without-node-native');

const BASE_URL = "https://moviesmod.army";
const CINEMETA_URL = "https://aiometadata.elfhosted.com/stremio/9197a4a9-2f5b-4911-845e-8704c520bdf7/meta";
const TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Referer": BASE_URL
};

// ================= UTILITY FUNCTIONS (from Utils.kt) =================

// Safe hostname validation using endsWith() - ensures domain is at the END of the hostname
// This prevents spoofing like "evilsite.comdriveseed.org" while allowing legitimate subdomains like "test.driveseed.org"
function isValidDownloadUrl(url) {
  try {
    // Try to parse as a full URL first
    const urlObj = new URL(url);
    const hostname = urlObj.hostname || "";
    return (
      hostname.endsWith("driveseed.org") || 
      hostname.endsWith("driveleech.org") ||
      hostname.endsWith("tech.unblockedgames.world") ||
      hostname.endsWith("tech.creativeexpressionsblog.com") || 
      hostname.endsWith("tech.examzculture.in")
    );
  } catch (e) {
    // Fallback for relative URLs - use regex to check hostname pattern
    const hostMatch = url.match(/^(?:https?:\/\/)?([^\/:?#]+)/);
    if (!hostMatch) return false;
    
    const host = hostMatch[1];
    return (
      host.endsWith("driveseed.org") || 
      host.endsWith("driveleech.org") ||
      host.endsWith("tech.unblockedgames.world") ||
      host.endsWith("tech.creativeexpressionsblog.com") || 
      host.endsWith("tech.examzculture.in")
    );
  }
}

function isTechUnblockedUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname || "";
    return (
      hostname.endsWith("tech.unblockedgames.world") ||
      hostname.endsWith("tech.creativeexpressionsblog.com") ||
      hostname.endsWith("tech.examzculture.in") ||
      hostname.endsWith("tech.examdegree.site")
    );
  } catch (e) {
    // Fallback for relative URLs
    const hostMatch = url.match(/^(?:https?:\/\/)?([^\/:?#]+)/);
    if (!hostMatch) return false;
    
    const host = hostMatch[1];
    return (
      host.endsWith("tech.unblockedgames.world") ||
      host.endsWith("tech.creativeexpressionsblog.com") ||
      host.endsWith("tech.examzculture.in") ||
      host.endsWith("tech.examdegree.site")
    );
  }
}

function isUnblockedUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes("unblocked");
  } catch (e) {
    return url.includes("unblocked");
  }
}

function fixUrl(url, domain) {
  if (url && url.startsWith("http")) return url;
  if (!url || url === "") return "";
  
  const startsWithNoHttp = url.startsWith("//");
  if (startsWithNoHttp) return "https:" + url;
  
  if (url.startsWith("/")) return domain + url;
  return domain + "/" + url;
}

function getBaseUrl(url) {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.hostname}`;
  } catch (e) {
    return url;
  }
}

// ================= HELPERS =================

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractQuality(text) {
  if (!text) return "Unknown";
  const m = text.match(/(480p|720p|1080p|2160p|4k)/i);
  return m ? m[1] : "Unknown";
}

function parseQualityForSort(q) {
  const m = (q || "").match(/(\d{3,4})p/i);
  return m ? parseInt(m[1], 10) : 0;
}

function getTechDetails(q) {
  if (!q) return [];
  const details = [];
  const t = q.toLowerCase();
  if (t.includes("10bit")) details.push("10-bit");
  if (t.includes("hevc") || t.includes("x265")) details.push("HEVC");
  if (t.includes("hdr")) details.push("HDR");
  return details;
}

async function bypass(url) {
  try {
    const host = getBaseUrl(url);
    let res = await makeRequest(url);
    let html = await res.text();
    let $ = cheerio.load(html);
    
    let formUrl = $("form#landing").attr("action");
    let formData = {};
    $("form#landing input").each((i, el) => {
      const name = $(el).attr("name");
      const value = $(el).attr("value");
      if (name) formData[name] = value || "";
    });
    
    if (!formUrl) return null;
    
    // First POST
    res = await makeRequest(formUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": url },
      body: new URLSearchParams(formData).toString()
    });
    
    html = await res.text();
    $ = cheerio.load(html);
    
    formUrl = $("form#landing").attr("action");
    formData = {};
    $("form#landing input").each((i, el) => {
      const name = $(el).attr("name");
      const value = $(el).attr("value");
      if (name) formData[name] = value || "";
    });
    
    if (!formUrl) return null;
    
    // Second POST
    res = await makeRequest(formUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": res.url || url },
      body: new URLSearchParams(formData).toString()
    });
    
    html = await res.text();
    $ = cheerio.load(html);
    
    // Extract token from script
    let skToken = null;
    $("script").each((i, el) => {
      const scriptData = $(el).html() || "";
      if (scriptData.includes("?go=")) {
        const match = scriptData.match(/\?go=([^"]+)/);
        if (match) skToken = match[1];
      }
    });
    
    if (!skToken) return null;
    
    const driveUrl = await makeRequest(
      host + "?go=" + skToken,
      {
        headers: {
          "Cookie": skToken + "=" + (formData["_wp_http2"] || ""),
          "Referer": res.url || url
        }
      }
    );
    
    html = await driveUrl.text();
    $ = cheerio.load(html);
    
    const refreshContent = $('meta[http-equiv="refresh"]').attr("content");
    if (!refreshContent) return null;
    
    const urlMatch = refreshContent.match(/url=([^&]+)/i);
    if (!urlMatch || !urlMatch[1]) return null;
    
    const actualDriveUrl = urlMatch[1].replace(/['"]/g, "");
    const driveRes = await makeRequest(actualDriveUrl, { headers: { "Referer": res.url || url } });
    const drivePath = await driveRes.text();
    
    const path = drivePath.match(/replace\("([^"]+)"\)/)?.[1];
    if (!path || path === "/404") return null;
    
    return fixUrl(path, getBaseUrl(actualDriveUrl));
  } catch (e) {
    console.error(`[MoviesMod] Bypass error: ${e.message}`);
    return null;
  }
}

function findBestMatch(mainString, targetStrings) {
  if (!targetStrings || targetStrings.length === 0)
    return { bestMatch: { target: "", rating: 0 }, bestMatchIndex: -1 };

  const ratings = targetStrings.map(target => {
    if (!target) return 0;
    const main = mainString.toLowerCase();
    const targ = target.toLowerCase();
    if (main === targ) return 1;
    if (targ.includes(main) || main.includes(targ)) return 0.8;
    const mainWords = main.split(/\s+/);
    const targWords = targ.split(/\s+/);
    let matches = 0;
    for (const word of mainWords) {
      if (word.length > 2 && targWords.some(tw => tw.includes(word) || word.includes(tw)))
        matches++;
    }
    return matches / Math.max(mainWords.length, targWords.length);
  });

  const bestRating = Math.max(...ratings);
  const bestIndex = ratings.indexOf(bestRating);
  return { bestMatch: { target: targetStrings[bestIndex], rating: bestRating }, bestMatchIndex: bestIndex };
}

async function makeRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...HEADERS, ...(options.headers || {}) },
    skipSizeCheck: true
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response;
}

// ================= SEARCH =================

async function searchMoviesMod(query) {
  try {
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    console.log(`[MoviesMod] Searching: ${searchUrl}`);
    const response = await makeRequest(searchUrl);
    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];
    $(".latestPost").each((i, el) => {
      const a = $(el).find("a");
      const title = a.attr("title");
      const url = a.attr("href");
      if (title && url) results.push({ title, url });
    });
    console.log(`[MoviesMod] Found ${results.length} search results`);
    return results;
  } catch (e) {
    console.error(`[MoviesMod] Search error: ${e.message}`);
    return [];
  }
}

// ================= DOWNLOAD LINK EXTRACTION =================

async function extractDownloadLinks(pageUrl) {
  try {
    const response = await makeRequest(pageUrl);
    const html = await response.text();
    const $ = cheerio.load(html);
    const links = [];
    const contentBox = $(".thecontent");
    const headers = contentBox.find('h3, h4').filter((i, el) => {
      const tag = $(el);
      // Include h3 tags that contain "Season" and all h4 tags
      return tag.is('h4') || tag.text().toLowerCase().includes('season');
    });

    headers.each((i, el) => {
      const header = $(el);
      const headerText = header.text().trim();
      const blockContent = header.nextUntil("h3, h4");

      if (header.is("h3") && headerText.toLowerCase().includes("season")) {
        // TV show section — find "Episode Links" anchors
        blockContent.find("a").filter((j, a) => {
          const text = $(a).text().trim().toLowerCase();
          return text.includes("episode links") && !text.includes("batch");
        }).each((j, a) => {
          const url = $(a).attr("href");
          if (url) links.push({ quality: `${headerText} - ${$(a).text().trim()}`, url });
        });
      } else if (header.is("h4")) {
        // Movie section — maxbutton download link
        const a = blockContent.find("a.maxbutton-download-links, .maxbutton").first();
        if (a.length > 0) {
          const url = a.attr("href");
          const cleanQuality = extractQuality(headerText);
          if (url && cleanQuality) links.push({ quality: cleanQuality, url });
        }
      }
    });

    console.log(`[MoviesMod] Extracted ${links.length} download links`);
    return links;
  } catch (e) {
    console.error(`[MoviesMod] Error extracting download links: ${e.message}`);
    return [];
  }
}

// ================= INTERMEDIATE LINK RESOLVER =================

async function resolveIntermediateLink(initialUrl, refererUrl) {
  try {
    const urlObj = new URL(initialUrl);
    const hostname = urlObj.hostname;
    
    // links.modpro.blog / posts.modpro.blog
    if (hostname.includes("links.modpro.blog") || hostname.includes("posts.modpro.blog")) {
      const response = await makeRequest(initialUrl, { headers: { Referer: refererUrl } });
      const html = await response.text();
      const $ = cheerio.load(html);
      const finalLinks = [];

      // Primary search in entry-content
      $(".entry-content a, .content a, main a").each((i, a) => {
        const href = $(a).attr("href") || "";
        const text = $(a).text().trim();
        if (
          isValidDownloadUrl(href) &&
          text && !text.toLowerCase().includes("batch")
        ) {
          finalLinks.push({ server: text.replace(/\s+/g, " "), url: href });
        }
      });

      // Fallback if nothing found
      if (finalLinks.length === 0) {
        $("a").each((i, a) => {
          const href = $(a).attr("href") || "";
          const text = $(a).text().trim();
          if (
            isValidDownloadUrl(href) &&
            text && !text.toLowerCase().includes("batch")
          ) {
            finalLinks.push({ server: text.replace(/\s+/g, " ") || "Download Link", url: href });
          }
        });
      }

      console.log(`[MoviesMod] Found ${finalLinks.length} links from ${hostname}`);
      return finalLinks;
    }

    // episodes.modpro.blog — per-episode links
    if (hostname.includes("episodes.modpro.blog")) {
      const response = await makeRequest(initialUrl, { headers: { Referer: refererUrl } });
      const html = await response.text();
      const $ = cheerio.load(html);
      const finalLinks = [];

      $("h3, h4").each((i, el) => {
        const headerText = $(el).text().trim();
        const epMatch = headerText.match(/Episode\s+(\d+)/i) || headerText.match(/Ep\.?\s*(\d+)/i);
        if (epMatch) {
          const a = $(el).find("a").first();
          if (!a.length) {
            // Try next sibling
            const nextLink = $(el).nextUntil("h3, h4").find("a").first();
            if (nextLink.length) {
              const href = nextLink.attr("href");
              if (href) finalLinks.push({ server: `Episode ${epMatch[1]}`, url: href });
            }
          } else {
            const href = a.attr("href");
            if (href) finalLinks.push({ server: `Episode ${epMatch[1]}`, url: href });
          }
        }
      });

      console.log(`[MoviesMod] Found ${finalLinks.length} episode links from episodes.modpro.blog`);
      return finalLinks;
    }

    // modrefer.in — base64 encoded redirect
    if (hostname.includes("modrefer.in")) {
      const encodedUrl = urlObj.searchParams.get("url");
      if (!encodedUrl) return [];
      
      let decodedUrl;
      try {
        decodedUrl = atob(encodedUrl);
      } catch (e) {
        console.error(`[MoviesMod] Base64 decode error: ${e.message}`);
        return [];
      }
      
      const response = await makeRequest(decodedUrl, { headers: { Referer: refererUrl } });
      const html = await response.text();
      const $ = cheerio.load(html);
      const finalLinks = [];

      $(".timed-content-client_show_0_5_0 a, .timed-show a").each((i, a) => {
        const href = $(a).attr("href");
        const text = $(a).text().trim();
        if (href && text) finalLinks.push({ server: text, url: href });
      });

      if (finalLinks.length === 0) {
        $("a").each((i, a) => {
          const href = $(a).attr("href") || "";
          const text = $(a).text().trim();
          if (isValidDownloadUrl(href)) {
            finalLinks.push({ server: text || "Download Link", url: href });
          }
        });
      }

      console.log(`[MoviesMod] Found ${finalLinks.length} total links from modrefer.in`);
      return finalLinks;
    }

    return [];
  } catch (e) {
    console.error(`[MoviesMod] Error resolving intermediate link: ${e.message}`);
    return [];
  }
}

// ================= SID (tech.unblockedgames.world) =================

async function resolveTechUnblockedLink(sidUrl) {
  try {
    console.log(`[MoviesMod] Resolving SID link: ${sidUrl}`);
    
    let response = await makeRequest(sidUrl);
    let html = await response.text();
    let $ = cheerio.load(html);

    let form = $("#landing");
    let wp_http = form.find('input[name="_wp_http"]').val();
    let action1 = form.attr("action");
    
    if (!wp_http || !action1) {
      // Try bypass method
      const bypassUrl = await bypass(sidUrl);
      if (bypassUrl) return bypassUrl;
      return null;
    }

    // First POST request
    response = await makeRequest(action1, {
      method: "POST",
      headers: { Referer: sidUrl, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _wp_http: wp_http }).toString()
    });

    html = await response.text();
    $ = cheerio.load(html);
    
    form = $("#landing");
    let action2 = form.attr("action");
    let wp_http2 = form.find('input[name="_wp_http2"]').val();
    let token = form.find('input[name="token"]').val();
    
    if (!action2 || !wp_http2) return null;

    // Second POST request
    response = await makeRequest(action2, {
      method: "POST",
      headers: { Referer: response.url || sidUrl, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _wp_http2: wp_http2, token: token || "" }).toString()
    });

    html = await response.text();
    
    // Extract cookie and final link
    const cookieMatch = html.match(/s_343\('([^']+)',\s*'([^']+)'/);
    const linkMatch = html.match(/c\.setAttribute\("href",\s*"([^"]+)"\)/);
    
    if (!cookieMatch || !linkMatch) {
      // Try alternate pattern
      const altLinkMatch = html.match(/window\.location\s*=\s*['"]([^'"]+)['"]/);
      if (altLinkMatch) return altLinkMatch[1];
      return null;
    }

    const cookieName = cookieMatch[1].trim();
    const cookieValue = cookieMatch[2].trim();
    const finalPath = linkMatch[1].trim();
    
    const sidUrlObj = new URL(sidUrl);
    const finalUrl = new URL(finalPath, sidUrlObj.origin).href;

    // Final request with cookie
    response = await makeRequest(finalUrl, {
      headers: { Referer: response.url || sidUrl, Cookie: `${cookieName}=${cookieValue}` }
    });

    html = await response.text();
    $ = cheerio.load(html);
    
    // Check for refresh meta tag
    const meta = $('meta[http-equiv="refresh"]');
    if (meta.length > 0) {
      const content = meta.attr("content");
      const urlMatch = content.match(/url=([^\s"']+)/i);
      if (urlMatch && urlMatch[1]) {
        const driveleechUrl = urlMatch[1].replace(/['"]/g, "");
        console.log(`[MoviesMod] SID resolved → ${driveleechUrl}`);
        return driveleechUrl;
      }
    }

    return null;
  } catch (e) {
    console.error(`[MoviesMod] SID resolution error: ${e.message}`);
    return null;
  }
}

// ================= DRIVESEED =================

async function resolveDriveseedLink(driveseedUrl) {
  try {
    const response = await makeRequest(driveseedUrl, { headers: { Referer: "https://links.modpro.blog/" } });
    const html = await response.text();
    const redirectMatch = html.match(/window\.location\.replace\("([^"]+)"\)/);
    if (!redirectMatch) return { downloadOptions: [], size: null, fileName: null };

    const finalUrl = `https://driveseed.org${redirectMatch[1]}`;
    const finalRes = await makeRequest(finalUrl, { headers: { Referer: driveseedUrl } });
    const finalHtml = await finalRes.text();
    const $ = cheerio.load(finalHtml);

    let size = null;
    let fileName = null;
    $("ul.list-group li").each((i, el) => {
      const text = $(el).text();
      if (text.includes("Size :")) size = text.split(":")[1].trim();
      else if (text.includes("Name :")) fileName = text.split(":")[1].trim();
    });

    const downloadOptions = [];

    const resumeLink = $('a').filter((i, el) => $(el).text().includes('Resume Cloud')).attr("href");
    if (resumeLink) downloadOptions.push({ title: "Resume Cloud", type: "resume", url: `https://driveseed.org${resumeLink}`, priority: 1 });

    const workerLink = $('a').filter((i, el) => $(el).text().includes('Resume Worker Bot')).attr("href");
    if (workerLink) downloadOptions.push({ title: "Resume Worker Bot", type: "worker", url: workerLink, priority: 2 });

    const instantLink = $('a').filter((i, el) => $(el).text().includes('Instant Download')).attr("href");
    if (instantLink) downloadOptions.push({ title: "Instant Download", type: "instant", url: instantLink, priority: 3 });

    $('a[href*="/download/"]').each((i, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (href && text && !downloadOptions.some(o => o.url === href)) {
        downloadOptions.push({
          title: text, type: "generic",
          url: href.startsWith("http") ? href : `https://driveseed.org${href}`,
          priority: 4
        });
      }
    });

    downloadOptions.sort((a, b) => a.priority - b.priority);
    return { downloadOptions, size, fileName };
  } catch (e) {
    console.error(`[MoviesMod] Driveseed error: ${e.message}`);
    return { downloadOptions: [], size: null, fileName: null };
  }
}

// ================= RESUME CLOUD =================

async function resolveResumeCloudLink(resumeUrl) {
  try {
    const response = await makeRequest(resumeUrl, { headers: { Referer: "https://driveseed.org/" } });
    const html = await response.text();
    const $ = cheerio.load(html);
    return $('a').filter((i, el) => $(el).text().includes('Cloud Resume Download')).attr("href") || null;
  } catch (e) {
    console.error(`[MoviesMod] Resume Cloud error: ${e.message}`);
    return null;
  }
}

// ================= VIDEOSEED (Instant Download) =================

async function resolveVideoSeedLink(videoSeedUrl) {
  try {
    const urlObj = new URL(videoSeedUrl);
    const keys = urlObj.searchParams.get("url");
    if (!keys) return null;

    const apiRes = await fetch(`${urlObj.origin}/api`, {
      method: "POST",
      body: new URLSearchParams({ keys }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-token": urlObj.hostname,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    if (apiRes.ok) {
      const data = await apiRes.json();
      return data?.url || null;
    }
    return null;
  } catch (e) {
    console.error(`[MoviesMod] VideoSeed error: ${e.message}`);
    return null;
  }
}

// ================= VALIDATE URL =================

async function validateVideoUrl(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { Range: "bytes=0-1", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    return res.ok || res.status === 206;
  } catch (e) {
    return false;
  }
}

// ================= PROCESS SINGLE LINK =================

async function processDownloadLink(link, selectedResult, mediaType, episodeNum) {
  try {
    console.log(`[MoviesMod] Processing quality: ${link.quality}`);
    const finalLinks = await resolveIntermediateLink(link.url, selectedResult.url);
    if (!finalLinks || finalLinks.length === 0) return null;

    let targetLinks = finalLinks;
    if ((mediaType === "tv" || mediaType === "series") && episodeNum !== null) {
      targetLinks = finalLinks.filter(tl => {
        const sn = tl.server.toLowerCase();
        return [
          new RegExp(`episode\\s+${episodeNum}\\b`, "i"),
          new RegExp(`ep\\s+${episodeNum}\\b`, "i"),
          new RegExp(`e${episodeNum}\\b`, "i"),
          new RegExp(`\\b${episodeNum}\\b`)
        ].some(p => p.test(sn));
      });
      if (targetLinks.length === 0) return null;
    }

    for (const tl of targetLinks) {
      try {
        let currentUrl = tl.url;

        // Handle unblocked links with bypass
        if (isUnblockedUrl(currentUrl)) {
          const bypassUrl = await bypass(currentUrl);
          if (!bypassUrl) continue;
          currentUrl = bypassUrl;
        }

        // Resolve SID links (tech.unblockedgames, tech.creative, tech.examz, etc.)
        if (isTechUnblockedUrl(currentUrl)) {
          const resolved = await resolveTechUnblockedLink(currentUrl);
          if (!resolved || resolved.includes("report-broken-links") || resolved.includes("moviesmod.wiki")) continue;
          currentUrl = resolved;
        }

        // Ensure we have a valid driveseed link
        if (!currentUrl) continue;
        
        try {
          const urlObj = new URL(currentUrl);
          if (!urlObj.hostname.endsWith("driveseed.org")) continue;
        } catch (e) {
          // For relative URLs, check if it starts with /
          if (!currentUrl.startsWith("/") && !currentUrl.match(/^https?:\/\/.*driveseed\.org/)) continue;
        }

        const { downloadOptions, size, fileName } = await resolveDriveseedLink(currentUrl);
        if (!downloadOptions || downloadOptions.length === 0) continue;

        let finalDownloadUrl = null;
        let usedMethod = null;

        for (const option of downloadOptions) {
          try {
            console.log(`[MoviesMod] Trying ${option.title} for ${link.quality}...`);
            if (option.type === "resume" || option.type === "worker") {
              finalDownloadUrl = await resolveResumeCloudLink(option.url);
            } else if (option.type === "instant") {
              finalDownloadUrl = await resolveVideoSeedLink(option.url);
            } else if (option.type === "generic") {
              finalDownloadUrl = option.url;
            }

            if (finalDownloadUrl) {
              const valid = await validateVideoUrl(finalDownloadUrl);
              if (valid) { usedMethod = option.title; break; }
              finalDownloadUrl = null;
            }
          } catch (e) {
            console.log(`[MoviesMod] ${option.title} failed: ${e.message}`);
          }
        }

        if (!finalDownloadUrl) continue;

        const actualQuality = extractQuality(link.quality);
        const sizeInfo = size || link.quality.match(/\[([^\]]+)\]/)?.[1];
        const cleanFileName = fileName
          ? fileName.replace(/\.[^/.]+$/, "").replace(/[._]/g, " ")
          : `Stream from ${link.quality}`;
        const techDetails = getTechDetails(link.quality);
        const techStr = techDetails.length > 0 ? ` • ${techDetails.join(" • ")}` : "";

        return {
          name: "MoviesMod",
          title: `${cleanFileName}\n${sizeInfo || ""}${techStr}`,
          url: finalDownloadUrl,
          quality: actualQuality,
          size: sizeInfo,
          fileName,
          subtitles: []
        };
      } catch (e) {
        console.error(`[MoviesMod] Error processing target link: ${e.message}`);
      }
    }

    return null;
  } catch (e) {
    console.error(`[MoviesMod] Error processing quality ${link.quality}: ${e.message}`);
    return null;
  }
}

// ================= MAIN =================

async function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  try {
    // Step 1: Get TMDB info
    const tmdbUrl = `https://api.themoviedb.org/3/${mediaType === "tv" ? "tv" : "movie"}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    const tmdbData = await (await makeRequest(tmdbUrl)).json();
    const title = mediaType === "tv" ? tmdbData.name : tmdbData.title;
    const year = mediaType === "tv"
      ? tmdbData.first_air_date?.substring(0, 4)
      : tmdbData.release_date?.substring(0, 4);

    if (!title) return [];
    console.log(`[MoviesMod] TMDB: "${title}" (${year})`);

    // Step 2: Search MoviesMod
    const searchResults = await searchMoviesMod(title);
    if (searchResults.length === 0) return [];

    // Step 3: Find best match
    const titles = searchResults.map(r => r.title);
    const bestMatch = findBestMatch(title, titles);
    console.log(`[MoviesMod] Best match: "${bestMatch.bestMatch.target}" (score: ${bestMatch.bestMatch.rating.toFixed(2)})`);

    let selectedResult = null;
    if (bestMatch.bestMatch.rating > 0.3) {
      selectedResult = searchResults[bestMatch.bestMatchIndex];
      if (mediaType === "movie" && year && !selectedResult.title.includes(year)) {
        console.log(`[MoviesMod] Year mismatch, discarding match`);
        selectedResult = null;
      }
    }

    if (!selectedResult) {
      const regex = new RegExp(`\\b${escapeRegExp(title.toLowerCase())}\\b`);
      if (mediaType === "movie") {
        selectedResult = searchResults.find(r => regex.test(r.title.toLowerCase()) && (!year || r.title.includes(year)));
      } else {
        selectedResult = searchResults.find(r => regex.test(r.title.toLowerCase()) && r.title.toLowerCase().includes("season"));
      }
    }

    if (!selectedResult) {
      console.log(`[MoviesMod] No suitable result found for "${title}"`);
      return [];
    }

    console.log(`[MoviesMod] Selected: ${selectedResult.title}`);

    // Step 4: Extract download links from page
    let downloadLinks = await extractDownloadLinks(selectedResult.url);
    if (downloadLinks.length === 0) return [];

    // Step 5: Filter by season and quality
    if ((mediaType === "tv" || mediaType === "series") && season !== null) {
      downloadLinks = downloadLinks.filter(l =>
        l.quality.toLowerCase().includes(`season ${season}`) ||
        l.quality.toLowerCase().includes(`s${season}`)
      );
    }

    // Remove 480p links
    downloadLinks = downloadLinks.filter(l => !l.quality.toLowerCase().includes("480p"));

    if (downloadLinks.length === 0) return [];

    // Step 6: Process each link to resolve final stream URL
    const rawStreams = await Promise.all(
      downloadLinks.map(link => processDownloadLink(link, selectedResult, mediaType, episode))
    );

    const streams = rawStreams.filter(Boolean);

    // Sort by quality descending
    streams.sort((a, b) => parseQualityForSort(b.quality) - parseQualityForSort(a.quality));

    console.log(`[MoviesMod] Returning ${streams.length} streams`);
    return streams;
  } catch (e) {
    console.error(`[MoviesMod] getStreams error: ${e.message}`);
    return [];
  }
}

// ================= EXPORT =================

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
