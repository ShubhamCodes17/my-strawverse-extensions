/**
 * StrawVerse Anime extension: AnimePahe
 *
 * Catalog + metadata + episode-list integration for animepahe.pw.
 * The site currently exposes search/release data through its public web API.
 *
 * Playback note:
 * AnimePahe's episode page exposes Kwik/embed links. This extension returns
 * those links as source candidates; direct HLS resolution can change when the
 * upstream player changes.
 */

const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://animepahe.pw";
const API_URL = `${BASE_URL}/api`;

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 12; K) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36";

const HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json,text/plain,*/*",
  Referer: `${BASE_URL}/`,
};

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function absoluteUrl(value) {
  if (!value) return "";
  try {
    return new URL(value, BASE_URL).toString();
  } catch (_) {
    return value;
  }
}

async function get(url, params = {}, responseType = "text") {
  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await axios.get(url, {
        params,
        headers: HEADERS,
        responseType,
        timeout: 20000,
        validateStatus: () => true,
      });

      if (response.status === 429 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`AnimePahe returned HTTP ${response.status}`);
      }

      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  throw lastError || new Error("AnimePahe request failed");
}

function normalizeSearchItem(item) {
  const session = String(item.session || item.id || "");
  return {
    id: session,
    title: cleanText(item.title),
    image: absoluteUrl(item.poster || item.snapshot),
    image_url: absoluteUrl(item.poster || item.snapshot),
    poster: absoluteUrl(item.poster || item.snapshot),
    url: `${BASE_URL}/anime/${session}`,
    malid: item.malid || item.mal_id || null,
    year: item.year || null,
    type: item.type || "TV",
  };
}

function normalizeEpisode(item, animeSession) {
  const episodeSession = String(item.session || "");
  const number = Number(item.episode ?? item.episode_number ?? item.number);

  return {
    id: `${animeSession}|${episodeSession}`,
    episodeId: episodeSession,
    animeSession,
    number: Number.isFinite(number) ? number : 0,
    title: cleanText(item.title || item.name || `Episode ${number}`),
    image: absoluteUrl(item.snapshot || item.image),
    image_url: absoluteUrl(item.snapshot || item.image),
    url: `${BASE_URL}/play/${animeSession}/${episodeSession}`,
    episodeSession,
    animeId: item.anime_id || null,
    filler: item.filler === 1 || item.filler === true,
    aired: item.created_at || item.createdAt || null,
  };
}

function parseAnimeIdFromId(id) {
  const raw = String(id || "");
  if (raw.includes("|")) return raw.split("|")[0];
  const match = raw.match(/(?:anime\/|\/a\/)([A-Za-z0-9-]+)/);
  return match ? match[1] : raw;
}

function parseEpisodeId(id) {
  const raw = String(id || "");
  if (raw.includes("|")) return raw.split("|")[1];
  const match = raw.match(/\/play\/[^/]+\/([^/?#]+)/);
  return match ? match[1] : raw;
}

async function SearchAnime(query, filters = {}) {
  const q = cleanText(query);
  if (!q) {
    return {
      results: [],
      currentPage: Number(filters.page || 1),
      hasNextPage: false,
    };
  }

  const page = Math.max(1, Number(filters.page || 1));
  const data = await get(API_URL, {
    m: "search",
    q,
    page,
  });

  const items = Array.isArray(data?.data) ? data.data : [];

  return {
    results: items.map(normalizeSearchItem),
    currentPage: Number(data.current_page || data.currentPage || page),
    hasNextPage:
      Number(data.current_page || data.currentPage || page) <
      Number(data.last_page || data.lastPage || page),
    totalPages: Number(data.last_page || data.lastPage || 1),
  };
}

async function fetchRecentEpisodes(filters = {}) {
  const page = Math.max(1, Number(filters.page || 1));

  const data = await get(API_URL, {
    m: "airing",
    page,
  });

  const items = Array.isArray(data?.data) ? data.data : [];

  return {
    results: items.map(normalizeSearchItem),
    currentPage: Number(data.current_page || data.currentPage || page),
    hasNextPage:
      Number(data.current_page || data.currentPage || page) <
      Number(data.last_page || data.lastPage || page),
    totalPages: Number(data.last_page || data.lastPage || 1),
  };
}

async function AnimeInfo(animeId) {
  const session = parseAnimeIdFromId(animeId);
  if (!session) throw new Error("AnimePahe session is missing");

  const html = await get(`${BASE_URL}/anime/${encodeURIComponent(session)}`);
  const $ = cheerio.load(html);

  const title = cleanText(
    $("div.title-wrapper > h1 > span").first().text() ||
      $("h1").first().text(),
  );

  const image =
    absoluteUrl(
      $("div.anime-poster a").first().attr("href") ||
        $("div.anime-poster img").first().attr("data-src") ||
        $("div.anime-poster img").first().attr("src"),
    );

  const description = cleanText($("div.anime-summary").first().text());

  const genres = $(
    "div.anime-genre ul li, " +
      'div.col-sm-4.anime-info p:contains("Demographic:") a, ' +
      'div.col-sm-4.anime-info p:contains("Theme:") a',
  )
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter(Boolean);

  const statusText = cleanText(
    $('div.col-sm-4.anime-info p:contains("Status:") a').first().text(),
  );

  const status =
    /currently airing/i.test(statusText)
      ? "Ongoing"
      : /finished airing/i.test(statusText)
        ? "Completed"
        : statusText || "Unknown";

  const studio = cleanText(
    $('div.col-sm-4.anime-info p:contains("Studios:")').first().text(),
  ).replace(/^Studios:\s*/i, "");

  const yearMatch = cleanText(
    $('div.col-sm-4.anime-info p:contains("Season:")').first().text(),
  ).match(/\b(19|20)\d{2}\b/);

  return {
    id: session,
    title,
    image,
    image_url: image,
    poster: image,
    description,
    genres,
    status,
    studio,
    year: yearMatch ? Number(yearMatch[0]) : null,
    url: `${BASE_URL}/anime/${session}`,
  };
}

async function fetchEpisode(animeId, page = 1) {
  const session = parseAnimeIdFromId(animeId);
  if (!session) throw new Error("AnimePahe session is missing");

  const currentPage = Math.max(1, Number(page || 1));

  const data = await get(API_URL, {
    m: "release",
    id: session,
    sort: "episode_asc",
    page: currentPage,
  });

  const items = Array.isArray(data?.data) ? data.data : [];

  return {
    episodes: items.map((item) => normalizeEpisode(item, session)),
    results: items.map((item) => normalizeEpisode(item, session)),
    currentPage: Number(data.current_page || data.currentPage || currentPage),
    hasNextPage:
      Number(data.current_page || data.currentPage || currentPage) <
      Number(data.last_page || data.lastPage || currentPage),
    totalPages: Number(data.last_page || data.lastPage || 1),
  };
}

async function fetchEpisodeSources(episodeId, category = null) {
  let animeSession;
  let episodeSession;

  if (String(episodeId).includes("|")) {
    [animeSession, episodeSession] = String(episodeId).split("|");
  } else {
    episodeSession = parseEpisodeId(episodeId);
    const match = String(episodeId).match(/\/play\/([^/]+)\//);
    animeSession = match ? match[1] : "";
  }

  if (!animeSession || !episodeSession) {
    throw new Error("AnimePahe episode session is missing");
  }

  const playUrl =
    `${BASE_URL}/play/${encodeURIComponent(animeSession)}/` +
    `${encodeURIComponent(episodeSession)}`;

  const html = await get(playUrl);
  const $ = cheerio.load(html);

  const sources = [];

  $("div#resolutionMenu > button").each((index, element) => {
    const button = $(element);

    const url = absoluteUrl(button.attr("data-src"));
    if (!url) return;

    const text = cleanText(button.text());
    const resolution =
      button.attr("data-resolution") ||
      (text.match(/(\d{3,4})p/i)?.[1] &&
        `${text.match(/(\d{3,4})p/i)[1]}p`) ||
      text ||
      `Source ${index + 1}`;

    const audio = String(button.attr("data-audio") || "").toLowerCase();
    const type =
      audio === "eng" || /eng/i.test(text) ? "dub" : "sub";

    if (
      category &&
      String(category).toLowerCase() !== type &&
      !(category === "hsub" && type === "sub")
    ) {
      return;
    }

    sources.push({
      url,
      quality: String(resolution),
      type,
      audio: audio || (type === "dub" ? "eng" : "jpn"),
      isM3U8: false,
      headers: {
        Referer: playUrl,
      },
      referer: playUrl,
      sourcePage: playUrl,
    });
  });

  // Some site versions expose the download/hoster link separately.
  $("div#pickDownload > a").each((index, element) => {
    const url = absoluteUrl($(element).attr("href"));
    if (!url) return;

    if (!sources.some((source) => source.url === url)) {
      sources.push({
        url,
        quality: `Download/Hoster ${index + 1}`,
        type: "sub",
        audio: "jpn",
        isM3U8: false,
        headers: {
          Referer: playUrl,
        },
        referer: playUrl,
        sourcePage: playUrl,
      });
    }
  });

  return {
    sources,
    subtitles: [],
    sourcePage: playUrl,
  };
}

module.exports = {
  name: "AnimePahe",
  version: "1.0.0",
  icon: "AnimePahe.ico",
  baseUrl: BASE_URL,
  SearchAnime,
  fetchRecentEpisodes,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
};
