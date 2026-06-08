// moviesmod.js
// MoviesMod - Hindi/English movies & series provider
// Flow: TMDB title → search moviesmod.army → parse download page → resolve modpro/driveseed chain → final MP4/MKV URL

const cheerio = require('cheerio-without-node-native');

const BASE_URL = "https://moviesmod.army";
const TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1"
};

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
    const headers = contentBox.find('h3:contains("Season"), h4');

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

    // links.modpro.blog / posts.modpro.blog
    if (urlObj.hostname.includes("links.modpro.blog") || urlObj.hostname.includes("posts.modpro.blog")) {
      const response = await makeRequest(initialUrl, { headers: { Referer: refererUrl } });
      const html = await response.text();
      const $ = cheerio.load(html);
      const finalLinks = [];

      $(".entry-content a").each((i, a) => {
        const href = $(a).attr("href") || "";
        const text = $(a).text().trim();
        if (
          (href.includes("driveseed.org") || href.includes("tech.unblockedgames.world") ||
           href.includes("tech.creativeexpressionsblog.com") || href.includes("tech.examzculture.in")) &&
          text && !text.toLowerCase().includes("batch")
        ) {
          finalLinks.push({ server: text.replace(/\s+/g, " "), url: href });
        }
      });

      // Broader fallback if nothing in entry-content
      if (finalLinks.length === 0) {
        $("a").each((i, a) => {
          const href = $(a).attr("href") || "";
          const text = $(a).text().trim();
          if (
            (href.includes("driveseed.org") || href.includes("tech.unblockedgames.world") ||
             href.includes("tech.creativeexpressionsblog.com") || href.includes("tech.examzculture.in")) &&
            text && !text.toLowerCase().includes("batch")
          ) {
            finalLinks.push({ server: text.replace(/\s+/g, " ") || "Download Link", url: href });
          }
        });
      }

      console.log(`[MoviesMod] Found ${finalLinks.length} links from ${urlObj.hostname}`);
      return finalLinks;
    }

    // episodes.modpro.blog — per-episode links
    if (urlObj.hostname.includes("episodes.modpro.blog")) {
      const response = await makeRequest(initialUrl, { headers: { Referer: refererUrl } });
      const html = await response.text();
      const $ = cheerio.load(html);
      const finalLinks = [];

      $("h3").each((i, el) => {
        const headerText = $(el).text().trim();
        const epMatch = headerText.match(/Episode\s+(\d+)/i);
        if (epMatch) {
          const a = $(el).find("a").first();
          const href = a.attr("href");
          if (href) finalLinks.push({ server: `Episode ${epMatch[1]}`, url: href });
        }
      });

      console.log(`[MoviesMod] Found ${finalLinks.length} episode links from episodes.modpro.blog`);
      return finalLinks;
    }

    // modrefer.in — base64 encoded redirect
    if (urlObj.hostname.includes("modrefer.in")) {
      const encodedUrl = urlObj.searchParams.get("url");
      if (!encodedUrl) return [];
      const decodedUrl = atob(encodedUrl);
      const response = await makeRequest(decodedUrl, { headers: { Referer: refererUrl } });
      const html = await response.text();
      const $ = cheerio.load(html);
      const finalLinks = [];

      $(".timed-content-client_show_0_5_0 a").each((i, a) => {
        const href = $(a).attr("href");
        const text = $(a).text().trim();
        if (href) finalLinks.push({ server: text, url: href });
      });

      if (finalLinks.length === 0) {
        $("a").each((i, a) => {
          const href = $(a).attr("href") || "";
          const text = $(a).text().trim();
          if (
            href.includes("driveseed.org") || href.includes("tech.unblockedgames.world") ||
            href.includes("tech.examzculture.in") || href.includes("tech.creativeexpressionsblog.com")
          ) {
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
    const response = await makeRequest(sidUrl);
    const html = await response.text();
    const $ = cheerio.load(html);

    const form = $("#landing");
    const wp_http = form.find('input[name="_wp_http"]').val();
    const action1 = form.attr("action");
    if (!wp_http || !action1) return null;

    const res1 = await makeRequest(action1, {
      method: "POST",
      headers: { Referer: sidUrl, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _wp_http: wp_http }).toString()
    });

    const html2 = await res1.text();
    const $2 = cheerio.load(html2);
    const form2 = $2("#landing");
    const action2 = form2.attr("action");
    const wp_http2 = form2.find('input[name="_wp_http2"]').val();
    const token = form2.find('input[name="token"]').val();
    if (!action2) return null;

    const res2 = await makeRequest(action2, {
      method: "POST",
      headers: { Referer: res1.url, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _wp_http2: wp_http2, token }).toString()
    });

    const finalHtml = await res2.text();
    const cookieMatch = finalHtml.match(/s_343\('([^']+)',\s*'([^']+)'/);
    const linkMatch = finalHtml.match(/c\.setAttribute\("href",\s*"([^"]+)"\)/);
    if (!cookieMatch || !linkMatch) return null;

    const cookieName = cookieMatch[1].trim();
    const cookieValue = cookieMatch[2].trim();
    const finalPath = linkMatch[1].trim();
    const finalUrl = new URL(finalPath, new URL(sidUrl).origin).href;

    const finalRes = await makeRequest(finalUrl, {
      headers: { Referer: res2.url, Cookie: `${cookieName}=${cookieValue}` }
    });

    const metaHtml = await finalRes.text();
    const $3 = cheerio.load(metaHtml);
    const meta = $3('meta[http-equiv="refresh"]');
    if (meta.length > 0) {
      const content = meta.attr("content");
      const urlMatch = content.match(/url=(.*)/i);
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

    const resumeLink = $('a:contains("Resume Cloud")').attr("href");
    if (resumeLink) downloadOptions.push({ title: "Resume Cloud", type: "resume", url: `https://driveseed.org${resumeLink}`, priority: 1 });

    const workerLink = $('a:contains("Resume Worker Bot")').attr("href");
    if (workerLink) downloadOptions.push({ title: "Resume Worker Bot", type: "worker", url: workerLink, priority: 2 });

    const instantLink = $('a:contains("Instant Download")').attr("href");
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
    return $('a:contains("Cloud Resume Download")').attr("href") || null;
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

        // Resolve SID links first
        if (
          currentUrl.includes("tech.unblockedgames.world") ||
          currentUrl.includes("tech.creativeexpressionsblog.com") ||
          currentUrl.includes("tech.examzculture.in") ||
          currentUrl.includes("tech.examdegree.site")
        ) {
          const resolved = await resolveTechUnblockedLink(currentUrl);
          if (!resolved || resolved.includes("report-broken-links") || resolved.includes("moviesmod.wiki")) continue;
          currentUrl = resolved;
        }

        if (!currentUrl || !currentUrl.includes("driveseed.org")) continue;

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
