// vendor/upstream/alpha.ts
import {
  askPaper,
  annotatePaper,
  clearPaperAnnotation,
  disconnect,
  getPaper,
  isLoggedIn,
  listPaperAnnotations,
  readPaperCode,
  searchPapers
} from "@companion-ai/alpha-hub/lib";
import { Type } from "typebox";

// vendor/upstream/alpha-sections.ts
var SECTION_ALIASES = {
  abstract: ["abstract", "summary", "overview"],
  introduction: ["introduction", "background", "motivation"],
  methodology: ["methodology", "methods", "approach", "method"],
  experiments: ["experiments", "experimental setup", "evaluation setup", "setup"],
  results: ["results", "findings", "performance"],
  discussion: ["discussion", "analysis", "interpretation"],
  limitations: ["limitations", "limit", "weaknesses"],
  conclusion: ["conclusion", "conclusions", "closing"]
};
function normalizeToken(value) {
  return value.trim().toLowerCase().replace(/^[#\s]+/, "").replace(/^[0-9]+(?:\.[0-9]+)*\s+/, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}
function toRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return;
  return value;
}
function canonicalizeSection(value) {
  const token = normalizeToken(value);
  if (!token)
    return;
  for (const [section, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.includes(token))
      return section;
  }
  return;
}
function buildSectionList(section, sections) {
  const tokens = [section, ...sections ?? []].filter((value) => typeof value === "string");
  const unique = new Set;
  for (const token of tokens) {
    const normalized = canonicalizeSection(token);
    if (normalized)
      unique.add(normalized);
  }
  return [...unique];
}
function pickObjectSections(content, requested) {
  const selected = {};
  const record = toRecord(content);
  if (!record)
    return selected;
  const entries = Object.entries(record);
  for (const section of requested) {
    const aliases = SECTION_ALIASES[section] ?? [section];
    for (const [key, value] of entries) {
      if (aliases.includes(normalizeToken(key))) {
        selected[section] = value;
        break;
      }
    }
  }
  const nestedSections = toRecord(record.sections);
  if (nestedSections) {
    for (const section of requested) {
      if (section in selected)
        continue;
      const aliases = SECTION_ALIASES[section] ?? [section];
      for (const [key, value] of Object.entries(nestedSections)) {
        if (aliases.includes(normalizeToken(key))) {
          selected[section] = value;
          break;
        }
      }
    }
  }
  return selected;
}
function pickTextSections(content, requested) {
  const selected = {};
  if (!requested.length)
    return selected;
  const lines = content.split(/\r?\n/);
  let activeSection;
  const buffers = new Map;
  for (const line of lines) {
    const maybeSection = canonicalizeSection(line);
    if (maybeSection && requested.includes(maybeSection)) {
      activeSection = maybeSection;
      if (!buffers.has(maybeSection))
        buffers.set(maybeSection, []);
      continue;
    }
    if (activeSection && isLikelySectionHeading(line)) {
      activeSection = undefined;
    }
    if (activeSection) {
      buffers.get(activeSection)?.push(line);
    }
  }
  for (const section of requested) {
    const body = (buffers.get(section) ?? []).join(`
`).trim();
    if (body)
      selected[section] = body;
  }
  return selected;
}
function isLikelySectionHeading(line) {
  return /^\s*(?:#{1,6}\s*)?(?:[0-9]+(?:\.[0-9]+)*\s+)?[A-Za-z][A-Za-z\s\-/]{2,80}:?\s*$/.test(line);
}
function extractPaperSections(content, section, sections) {
  const requested = buildSectionList(section, sections);
  if (!requested.length) {
    return { requested: [], selected: {}, missing: [] };
  }
  const selected = typeof content === "string" ? pickTextSections(content, requested) : pickObjectSections(content, requested);
  const missing = requested.filter((name) => !(name in selected));
  return { requested, selected, missing };
}

// lib/transport.js
import { AsyncLocalStorage } from "node:async_hooks";
var requests = new AsyncLocalStorage;
function withResearchRequest(options, run) {
  return requests.run(options, run);
}
async function researchFetch(input, init = {}) {
  const request = requests.getStore() ?? {};
  request.signal?.throwIfAborted();
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init.headers);
  if (url.hostname === "huggingface.co" && request.hfToken)
    headers.set("Authorization", `Bearer ${request.hfToken}`);
  if (url.hostname === "api.openalex.org" && request.openalexToken)
    url.searchParams.set("api_key", request.openalexToken);
  if (url.hostname === "api.semanticscholar.org" && request.semanticToken)
    headers.set("x-api-key", request.semanticToken);
  const signals = [init.signal, request.signal, AbortSignal.timeout(30000)].filter(Boolean);
  return globalThis.fetch(url, { ...init, headers, signal: AbortSignal.any(signals) });
}

// vendor/upstream/science-database-arxiv.ts
import { XMLParser } from "fast-xml-parser";

// vendor/upstream/request-pacer.ts
function createRequestPacer() {
  let queue = Promise.resolve();
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  return (minGapMs, run) => {
    const next = queue.then(async () => {
      const wait = lastStartedAt + minGapMs - Date.now();
      if (wait > 0)
        await new Promise((resolve) => setTimeout(resolve, wait));
      lastStartedAt = Date.now();
      return run();
    });
    queue = next.catch(() => {});
    return next;
  };
}

// vendor/upstream/science-database-arxiv.ts
var ARXIV_QUERY_URL = "https://export.arxiv.org/api/query";
var MAX_ARXIV_EXACT_RESULTS = 100;
var REQUEST_TIMEOUT_MS = 25000;
var xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true
});
function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function cleanQuery(query) {
  const clean = query.trim();
  if (!clean)
    throw new Error("Science database search requires a non-empty query.");
  return clean;
}
var arxivPacer = createRequestPacer();
var ARXIV_MIN_GAP_MS = 3000;

class ArxivTopicQueryError extends Error {
  topic;
  constructor(message, topic) {
    super(message);
    this.topic = topic;
  }
}

class ArxivUnavailableError extends Error {
  ids;
  constructor(message, ids) {
    super(message);
    this.ids = ids;
  }
}
async function fetchText(url, accept) {
  for (let attempt = 0;; attempt += 1) {
    const result = await arxivPacer(ARXIV_MIN_GAP_MS, async () => {
      const controller = new AbortController;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await researchFetch(url, {
          headers: { accept },
          signal: controller.signal
        });
        if (response.status === 429 && attempt === 0)
          return;
        if (!response.ok) {
          throw new Error(`${url.hostname} request failed: ${response.status} ${response.statusText}`);
        }
        return await response.text();
      } finally {
        clearTimeout(timeout);
      }
    });
    if (result !== undefined)
      return result;
  }
}
function doiUrl(doi) {
  return doi ? `https://doi.org/${doi}` : undefined;
}
function arxivArray(value) {
  if (value === undefined || value === null)
    return [];
  return Array.isArray(value) ? value : [value];
}
function arxivAuthors(value) {
  return arxivArray(value).map((author) => stringValue(recordValue(author).name)).filter((name) => Boolean(name)).slice(0, 8);
}
function arxivLinks(value) {
  return arxivArray(value).map((link) => recordValue(link));
}
function parseToolKeyValueQuery(query) {
  const flags = {};
  const textParts = [];
  for (const part of query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const match = part.match(/^([a-z_]+)=(.+)$/i);
    if (match?.[1] && match[2] !== undefined)
      flags[match[1].toLowerCase()] = match[2].replace(/^"|"$/g, "");
    else
      textParts.push(part);
  }
  return { flags, text: textParts.join(" ").replace(/^"|"$/g, "").trim() };
}
function stripGetPapersCommand(query) {
  return query.trim().replace(/^arxiv_get_papers(?::|\s+)?/i, "").trim();
}
function normalizeArxivId(raw) {
  let clean = raw.trim();
  clean = clean.replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, "");
  clean = clean.replace(/^arxiv:/i, "");
  clean = clean.replace(/\.pdf$/i, "");
  return clean || undefined;
}
function splitArxivVersion(id) {
  if (!id)
    return {};
  const match = id.match(/^(.*?)(?:v(\d+))?$/);
  return {
    arxivId: match?.[1] || id,
    version: match?.[2] ? Number(match[2]) : undefined
  };
}
function parseArxivEntry(entry) {
  const idUrl = stringValue(entry.id);
  if (!idUrl)
    return;
  const idVersioned = idUrl.split("/abs/").pop() ?? idUrl.split("/").pop();
  const split = splitArxivVersion(idVersioned);
  const doi = stringValue(entry.doi);
  const pdfLink = arxivLinks(entry.link).find((link) => stringValue(link["@_title"]) === "pdf" || stringValue(link["@_type"]) === "application/pdf");
  return {
    arxiv_id: split.arxivId,
    version: split.version,
    id_versioned: idVersioned,
    title: stringValue(entry.title)?.replace(/\s+/g, " "),
    abstract: stringValue(entry.summary)?.replace(/\s+/g, " "),
    authors: arxivAuthors(entry.author),
    published: stringValue(entry.published),
    updated: stringValue(entry.updated),
    primary_category: stringValue(recordValue(entry.primary_category)["@_term"]),
    categories: arxivArray(entry.category).map((category) => stringValue(recordValue(category)["@_term"])).filter(Boolean),
    doi,
    journal_ref: stringValue(entry.journal_ref),
    comment: stringValue(entry.comment),
    abs_url: idUrl,
    pdf_url: stringValue(pdfLink?.["@_href"]),
    ...doiUrl(doi) ? { doi_url: doiUrl(doi) } : {}
  };
}
function arxivFeedEntries(feed) {
  const entries = arxivArray(feed.entry).map(recordValue);
  if (entries.length === 1 && stringValue(entries[0]?.id)?.includes("/api/errors")) {
    throw new Error(`arXiv API error: ${stringValue(entries[0]?.summary) ?? stringValue(entries[0]?.title) ?? "unknown error"}`);
  }
  return entries;
}
function arxivTopicText(query) {
  return query.replace(/&?\b(?:max_results|start|sortBy|sortOrder)=[^&\s]*/gi, " ").replace(/\b(?:AND|OR|ANDNOT)\s+submittedDate:\[[^\]]*\]/gi, " ").replace(/\bsearch_query[=_:]+/gi, " ").replace(/\b(?:all|ti|abs|au|cat|co|jr):/gi, " ").replace(/[&"()]/g, " ").replace(/\s+/g, " ").trim();
}
async function getArxivPapers(query) {
  const parsed = parseToolKeyValueQuery(stripGetPapersCommand(query));
  const requested = (parsed.flags.ids ?? parsed.text).split(/[,\s]+/).map((id) => id.trim()).filter(Boolean).slice(0, MAX_ARXIV_EXACT_RESULTS);
  const arxivIdPattern = /^(\d{4}\.\d{4,5}|[a-z][a-z-]*(\.[A-Za-z-]+)?\/\d{7})(v\d+)?$/;
  const ids = [];
  const notFound = [];
  for (const raw of requested) {
    const normalized = normalizeArxivId(raw);
    if (normalized && arxivIdPattern.test(normalized))
      ids.push(normalized);
    else
      notFound.push(raw);
  }
  if (!ids.length) {
    throw new ArxivTopicQueryError(`No arXiv IDs found in "${query}". The arxiv source only looks up papers by ID; search topics with source semanticscholar or openalex.`, arxivTopicText(parsed.text || stripGetPapersCommand(query)));
  }
  const rows = [];
  const duplicates = [];
  const url = new URL(ARXIV_QUERY_URL);
  url.search = new URLSearchParams({ id_list: ids.join(","), max_results: String(ids.length) }).toString();
  let xml;
  try {
    xml = await fetchText(url, "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8");
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s` : error instanceof Error ? error.message : String(error);
    if (error instanceof Error && (error.name === "AbortError" || /request failed: (?:429|5\d\d)\b/.test(error.message))) {
      throw new ArxivUnavailableError(reason, ids);
    }
    throw error;
  }
  const feed = recordValue(xmlParser.parse(xml).feed);
  const byId = new Map;
  for (const row of arxivFeedEntries(feed).map(parseArxivEntry).filter((item) => Boolean(item))) {
    if (row.arxiv_id) {
      const bare = String(row.arxiv_id);
      const latest = byId.get(bare);
      if (!latest || Number(row.version) >= Number(latest.version))
        byId.set(bare, row);
    }
    if (row.id_versioned)
      byId.set(String(row.id_versioned), row);
  }
  const seen = new Map;
  for (const id of ids) {
    const row = byId.get(id);
    if (!row)
      notFound.push(id);
    else if (seen.has(row))
      duplicates.push({ requested: id, resolved_as: seen.get(row) });
    else {
      seen.set(row, id);
      rows.push(row);
    }
  }
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "arxiv",
    query,
    mode: "arxiv_get_papers",
    n_requested: requested.length,
    n_found: rows.length,
    duplicates,
    not_found: notFound,
    records: rows,
    results: rows,
    provenance: { docs: "https://info.arxiv.org/help/api/user-manual.html", endpoints: [url.toString()] }
  };
}
async function searchArxiv(params) {
  const query = cleanQuery(params.query);
  if (/^arxiv_search\b/i.test(query)) {
    throw new Error("arXiv topic search was removed. Search with source semanticscholar or openalex, then look up arXiv IDs here.");
  }
  return getArxivPapers(query);
}

// vendor/upstream/science-database-openalex-exact.ts
var MAX_EXACT_RECORDS = 50;
var REQUEST_TIMEOUT_MS2 = 25000;
var OPENALEX_BASE = "https://api.openalex.org";
var OPEN_ABSTRACT_LICENSES = new Set(["cc-by", "cc-by-sa", "cc0", "public-domain"]);
function recordValue2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}
function stringValue2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return;
}
function booleanValue(value) {
  if (value === undefined)
    return;
  if (/^(true|1|yes)$/i.test(value))
    return true;
  if (/^(false|0|no)$/i.test(value))
    return false;
  return;
}
function safeExactLimit(value, fallback = 50) {
  if (!Number.isFinite(value) || value === undefined)
    return fallback;
  return Math.max(1, Math.min(Math.floor(value), MAX_EXACT_RECORDS));
}
function openAlexDocs() {
  return [
    "https://developers.openalex.org/api-reference/introduction",
    "https://developers.openalex.org/api-reference/authentication",
    "https://developers.openalex.org/api-reference/works",
    "https://developers.openalex.org/api-entities/works/work-object"
  ];
}
function endpointPath(path) {
  return new URL(`${OPENALEX_BASE}${path.startsWith("/") ? path : `/${path}`}`);
}
var OPENALEX_API_KEY_HINT = "Get a free OpenAlex API key at https://openalex.org/settings/api and set OPENALEX_API_KEY; anonymous requests share a small daily budget.";
var OPENALEX_ENTITY_SEARCH = {
  works: ["work", "openalex_search_works:<title or topic>"],
  authors: ["author", "openalex_search_authors:<name>"],
  sources: ["source", "sources:<name>"]
};
function openAlexRequestFailure(status, statusText, snippet, usingApiKey, url) {
  const lookup = status === 404 ? url?.pathname.match(/^\/(works|authors|sources)\/([^/]+)$/) : null;
  const known = lookup ? OPENALEX_ENTITY_SEARCH[lookup[1]] : undefined;
  if (lookup && known) {
    const [entity, search] = known;
    return new Error(`OpenAlex has no ${entity} "${decodeURIComponent(lookup[2])}". Lookups take an OpenAlex ID or DOI; to find one by name or title, use ${search}.`);
  }
  const hint = !usingApiKey && [401, 403, 429].includes(status) ? ` ${OPENALEX_API_KEY_HINT}` : "";
  return new Error(`OpenAlex request failed: ${status} ${statusText}. ${snippet}${hint}`);
}
function openAlexApiKey() {
  return process.env.OPENALEX_API_KEY?.trim() || undefined;
}
function addAuth(url) {
  const key = openAlexApiKey();
  if (key) {
    url.searchParams.set("api_key", key);
    return { credentialStatus: "OPENALEX_API_KEY present", usingApiKey: true };
  }
  return { credentialStatus: `OPENALEX_API_KEY missing. ${OPENALEX_API_KEY_HINT}`, usingApiKey: false };
}
function scrubOpenAlexEndpoint(url) {
  const clean = new URL(url.toString());
  if (clean.searchParams.has("api_key"))
    clean.searchParams.set("api_key", "[redacted]");
  return clean.toString();
}
function scrubOpenAlexText(text, url) {
  const key = url.searchParams.get("api_key");
  if (!key || key.length < 6)
    return text;
  let scrubbed = text;
  for (const form of [key, encodeURIComponent(key), encodeURIComponent(encodeURIComponent(key))]) {
    scrubbed = scrubbed.split(form).join("[redacted]");
  }
  return scrubbed;
}
async function fetchJson(url) {
  const auth = addAuth(url);
  const endpoint = scrubOpenAlexEndpoint(url);
  const controller = new AbortController;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS2);
  try {
    const response = await researchFetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "feynman-science-database-search/1.0 (https://github.com/Companion-Inc/feynman)"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      const snippet = scrubOpenAlexText((await response.text()).slice(0, 4096), url).slice(0, 240);
      throw openAlexRequestFailure(response.status, response.statusText, snippet, auth.usingApiKey, url);
    }
    return { ...auth, endpoint, payload: await response.json() };
  } finally {
    clearTimeout(timeout);
  }
}
function shortOpenAlexId(value) {
  const raw = stringValue2(value);
  if (!raw)
    return;
  return raw.split("/").pop() || raw;
}
function doiValue(value) {
  const raw = stringValue2(value);
  if (!raw)
    return;
  return raw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}
function externalId(value) {
  const raw = stringValue2(value);
  if (!raw)
    return;
  return raw.split("/").pop() || raw;
}
function reconstructAbstract(index) {
  const inverted = recordValue2(index);
  const positions = [];
  for (const [word, rawPositions] of Object.entries(inverted)) {
    for (const position of arrayValue(rawPositions)) {
      const numeric = numberValue(position);
      if (numeric !== undefined)
        positions.push({ position: numeric, word });
    }
  }
  if (!positions.length)
    return;
  return positions.sort((a, b) => a.position - b.position).map((item) => item.word).join(" ");
}
function workLicense(work) {
  for (const locationKey of ["primary_location", "best_oa_location"]) {
    const raw = stringValue2(recordValue2(work[locationKey]).license);
    if (raw)
      return raw.split("/").pop()?.toLowerCase() || raw.toLowerCase();
  }
  return;
}
function normalizeAuthorship(value) {
  const authorship = recordValue2(value);
  const author = recordValue2(authorship.author);
  return {
    authorId: shortOpenAlexId(author.id),
    name: stringValue2(author.display_name),
    orcid: stringValue2(author.orcid),
    position: stringValue2(authorship.author_position),
    isCorresponding: authorship.is_corresponding === true,
    institutions: arrayValue(authorship.institutions).map((item) => stringValue2(recordValue2(item).display_name)).filter(Boolean).slice(0, 6)
  };
}
function normalizeOpenAlexWork(work, includeAbstract) {
  const id = shortOpenAlexId(work.id);
  const ids = recordValue2(work.ids);
  const primary = recordValue2(work.primary_location);
  const bestOa = recordValue2(work.best_oa_location);
  const source = recordValue2(primary.source);
  const openAccess = recordValue2(work.open_access);
  const topic = recordValue2(work.primary_topic);
  const license = workLicense(work);
  const abstract = includeAbstract && license && OPEN_ABSTRACT_LICENSES.has(license) ? reconstructAbstract(work.abstract_inverted_index) : undefined;
  return {
    openalexId: id,
    url: id ? `https://openalex.org/${id}` : stringValue2(work.id),
    doi: doiValue(work.doi ?? ids.doi),
    pmid: externalId(ids.pmid),
    pmcid: externalId(ids.pmcid),
    title: stringValue2(work.title) ?? stringValue2(work.display_name),
    publicationYear: numberValue(work.publication_year),
    publicationDate: stringValue2(work.publication_date),
    type: stringValue2(work.type),
    language: stringValue2(work.language),
    isRetracted: work.is_retracted === true,
    authors: arrayValue(work.authorships).map(normalizeAuthorship).slice(0, 12),
    source: source.id || source.display_name ? {
      sourceId: shortOpenAlexId(source.id),
      displayName: stringValue2(source.display_name),
      issnL: stringValue2(source.issn_l),
      type: stringValue2(source.type)
    } : undefined,
    biblio: recordValue2(work.biblio),
    citedByCount: numberValue(work.cited_by_count),
    fwci: numberValue(work.fwci),
    referencedWorksCount: numberValue(work.referenced_works_count),
    openAccess: {
      isOpenAccess: openAccess.is_oa === true,
      status: stringValue2(openAccess.oa_status),
      url: stringValue2(openAccess.oa_url)
    },
    bestOaPdfUrl: stringValue2(bestOa.pdf_url),
    primaryTopic: stringValue2(topic.display_name),
    keywords: arrayValue(work.keywords).map((item) => stringValue2(recordValue2(item).display_name)).filter(Boolean).slice(0, 8),
    abstract,
    abstractLicense: license,
    abstractPolicy: includeAbstract && !abstract ? "Abstract omitted unless OpenAlex exposes a declared open license and an inverted index." : undefined
  };
}
function exactAuthorship(value) {
  const normalized = normalizeAuthorship(value);
  return {
    author_id: normalized.authorId,
    name: normalized.name,
    orcid: normalized.orcid,
    position: normalized.position,
    is_corresponding: normalized.isCorresponding,
    institutions: normalized.institutions
  };
}
function exactOpenAlexWork(work, includeAbstract) {
  const normalized = normalizeOpenAlexWork(work, includeAbstract);
  const source = recordValue2(normalized.source);
  const openAccess = recordValue2(normalized.openAccess);
  return {
    openalex_id: normalized.openalexId,
    url: normalized.url,
    doi: normalized.doi,
    pmid: normalized.pmid,
    pmcid: normalized.pmcid,
    title: normalized.title,
    publication_year: normalized.publicationYear,
    publication_date: normalized.publicationDate,
    type: normalized.type,
    language: normalized.language,
    is_retracted: normalized.isRetracted,
    authors: arrayValue(work.authorships).map(exactAuthorship).slice(0, 12),
    source: source.sourceId || source.displayName ? {
      source_id: source.sourceId,
      display_name: source.displayName,
      issn_l: source.issnL,
      type: source.type
    } : undefined,
    biblio: normalized.biblio,
    cited_by_count: normalized.citedByCount,
    fwci: normalized.fwci,
    referenced_works_count: normalized.referencedWorksCount,
    open_access: {
      is_oa: openAccess.isOpenAccess,
      oa_status: openAccess.status,
      oa_url: openAccess.url
    },
    best_oa_pdf_url: normalized.bestOaPdfUrl,
    primary_topic: normalized.primaryTopic,
    keywords: normalized.keywords,
    abstract: normalized.abstract,
    abstract_license: normalized.abstractLicense,
    abstract_policy: normalized.abstractPolicy
  };
}
function normalizeAuthor(author) {
  const id = shortOpenAlexId(author.id);
  const summaryStats = recordValue2(author.summary_stats);
  return {
    authorId: id,
    url: id ? `https://openalex.org/${id}` : stringValue2(author.id),
    name: stringValue2(author.display_name),
    orcid: stringValue2(author.orcid),
    worksCount: numberValue(author.works_count),
    citedByCount: numberValue(author.cited_by_count),
    hIndex: numberValue(summaryStats.h_index),
    i10Index: numberValue(summaryStats.i10_index),
    lastKnownInstitutions: arrayValue(author.last_known_institutions).map((item) => stringValue2(recordValue2(item).display_name)).filter(Boolean).slice(0, 6),
    topics: arrayValue(author.topics).map((item) => stringValue2(recordValue2(item).display_name)).filter(Boolean).slice(0, 8)
  };
}
function exactAuthor(author) {
  const normalized = normalizeAuthor(author);
  return {
    author_id: normalized.authorId,
    url: normalized.url,
    name: normalized.name,
    orcid: normalized.orcid,
    works_count: normalized.worksCount,
    cited_by_count: normalized.citedByCount,
    h_index: normalized.hIndex,
    i10_index: normalized.i10Index,
    last_known_institutions: normalized.lastKnownInstitutions,
    top_topics: normalized.topics
  };
}
function normalizeSource(source) {
  const id = shortOpenAlexId(source.id);
  const summaryStats = recordValue2(source.summary_stats);
  return {
    sourceId: id,
    url: id ? `https://openalex.org/${id}` : stringValue2(source.id),
    displayName: stringValue2(source.display_name),
    issnL: stringValue2(source.issn_l),
    issn: arrayValue(source.issn).map(String).filter(Boolean),
    type: stringValue2(source.type),
    worksCount: numberValue(source.works_count),
    citedByCount: numberValue(source.cited_by_count),
    hIndex: numberValue(summaryStats.h_index),
    i10Index: numberValue(summaryStats.i10_index),
    isOa: source.is_oa === true,
    homepageUrl: stringValue2(source.homepage_url)
  };
}
function exactSource(source) {
  const normalized = normalizeSource(source);
  return {
    source_id: normalized.sourceId,
    url: normalized.url,
    display_name: normalized.displayName,
    issn_l: normalized.issnL,
    issn: normalized.issn,
    type: normalized.type,
    works_count: normalized.worksCount,
    cited_by_count: normalized.citedByCount,
    h_index: normalized.hIndex,
    i10_index: normalized.i10Index,
    is_oa: normalized.isOa,
    homepage_url: normalized.homepageUrl,
    counts_by_year: arrayValue(source.counts_by_year).slice(0, 12)
  };
}
function parseKeyValueQuery(query) {
  const flags = {};
  const textParts = [];
  for (const part of query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const match = part.match(/^([a-z_]+)=(.+)$/i);
    if (match?.[1] && match[2] !== undefined)
      flags[match[1].toLowerCase()] = match[2].replace(/^"|"$/g, "");
    else
      textParts.push(part);
  }
  return { flags, text: textParts.join(" ").replace(/^"|"$/g, "").trim() };
}
function normalizeWorkId(value) {
  const clean = value.trim();
  const openAlexUrl = clean.match(/^https?:\/\/openalex\.org\/(W\d+)$/i);
  if (openAlexUrl?.[1])
    return openAlexUrl[1].toUpperCase();
  const doiUrl2 = clean.match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\..+)$/i);
  if (doiUrl2?.[1])
    return `doi:${doiUrl2[1]}`;
  if (/^doi:\s*10\./i.test(clean))
    return `doi:${clean.replace(/^doi:\s*/i, "")}`;
  if (/^10\..+\/.+/.test(clean))
    return `doi:${clean}`;
  if (/^W\d+$/i.test(clean))
    return clean.toUpperCase();
  return clean;
}
function normalizeEntityId(value, prefix) {
  const clean = value.trim();
  const openAlexUrl = clean.match(new RegExp(`^https?://openalex\\.org/(${prefix}\\d+)$`, "i"));
  if (openAlexUrl?.[1])
    return openAlexUrl[1].toUpperCase();
  if (new RegExp(`^${prefix}\\d+$`, "i").test(clean))
    return clean.toUpperCase();
  if (prefix === "S" && /^(?:issn:)?\d{4}-\d{3}[\dXx]$/.test(clean))
    return clean.replace(/^issn:/i, "").toUpperCase();
  return clean;
}
function exactCommand(query) {
  const match = query.trim().match(/^(openalex_(?:search_works|get_work|citations|references|search_authors|get_author|venue_info))(?::|\s+)?(.*)$/i);
  if (!match?.[1])
    return;
  return { name: match[1].toLowerCase(), rest: (match[2] ?? "").trim() };
}
function exactSearchSort(value, hasSearch) {
  if (value === "cited_by_count")
    return "cited_by_count:desc";
  if (value === "publication_date" || value === "pub_date")
    return "publication_date:desc";
  if (value === "relevance" && hasSearch)
    return "relevance_score:desc";
  return;
}
function exactOpenAlexOutput(payload, mode, query, endpoints, credentialStatus) {
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "openalex",
    query,
    mode,
    credentialStatus,
    provenance: { docs: openAlexDocs(), endpoints },
    ...payload
  };
}
function doiClaimants(results) {
  return results.map((item) => {
    const work = recordValue2(item);
    return {
      openalexId: shortOpenAlexId(work.id),
      title: stringValue2(work.title) ?? stringValue2(work.display_name),
      publicationYear: numberValue(work.publication_year),
      citedByCount: numberValue(work.cited_by_count)
    };
  });
}
async function resolveDoiWork(doiWorkId) {
  const doi = doiWorkId.replace(/^doi:/i, "");
  const url = endpointPath("/works");
  url.searchParams.set("filter", `doi:${doi}`);
  url.searchParams.set("sort", "cited_by_count:desc");
  url.searchParams.set("per-page", "20");
  const result = await fetchJson(url);
  const rows = arrayValue(recordValue2(result.payload).results).map(recordValue2).sort((a, b) => (numberValue(b.cited_by_count) ?? 0) - (numberValue(a.cited_by_count) ?? 0));
  if (!rows.length)
    throw new Error(`OpenAlex has no work for doi:${doi}`);
  const claimants = doiClaimants(rows);
  const workId = shortOpenAlexId(rows[0]?.id) ?? doiWorkId;
  return {
    claimants,
    credentialStatus: result.credentialStatus,
    endpoints: [result.endpoint],
    payload: rows[0] ?? {},
    resolutionNote: claimants.length > 1 ? `${claimants.length} OpenAlex works claim doi:${doi}; selected the most-cited claimant ${workId}.` : undefined,
    workId
  };
}
async function fetchWorkById(workId) {
  const id = normalizeWorkId(workId);
  if (/^doi:10\./i.test(id)) {
    const resolved = await resolveDoiWork(id);
    return {
      credentialStatus: resolved.credentialStatus,
      endpoints: resolved.endpoints,
      payload: resolved.payload,
      resolutionNote: resolved.resolutionNote,
      claimants: resolved.claimants,
      workId: resolved.workId
    };
  }
  const result = await fetchJson(endpointPath(`/works/${encodeURIComponent(id)}`));
  const payload = recordValue2(result.payload);
  return {
    credentialStatus: result.credentialStatus,
    endpoints: [result.endpoint],
    payload,
    workId: shortOpenAlexId(payload.id) ?? id
  };
}
async function exactWorkSearch(query, commandQuery, defaultLimit) {
  const parsed = parseKeyValueQuery(commandQuery);
  const maxRecords = safeExactLimit(numberValue(parsed.flags.max_records), defaultLimit ?? 50);
  const url = endpointPath("/works");
  if (parsed.text)
    url.searchParams.set("search", parsed.text);
  const filters = [];
  if (parsed.flags.year_from && parsed.flags.year_to)
    filters.push(`publication_year:${parsed.flags.year_from}-${parsed.flags.year_to}`);
  else if (parsed.flags.year_from)
    filters.push(`publication_year:>${Number(parsed.flags.year_from) - 1}`);
  else if (parsed.flags.year_to)
    filters.push(`publication_year:<${Number(parsed.flags.year_to) + 1}`);
  if (parsed.flags.work_type)
    filters.push(`type:${parsed.flags.work_type}`);
  if (booleanValue(parsed.flags.open_access_only) === true)
    filters.push("open_access.is_oa:true");
  if (parsed.flags.venue)
    filters.push(`primary_location.source.id:${normalizeEntityId(parsed.flags.venue, "S")}`);
  if (!parsed.text && !filters.length)
    throw new Error("openalex_search_works requires a query, venue, year, type, or open-access filter.");
  if (filters.length)
    url.searchParams.set("filter", filters.join(","));
  const sort = exactSearchSort(parsed.flags.sort ?? "relevance", Boolean(parsed.text));
  if (sort)
    url.searchParams.set("sort", sort);
  url.searchParams.set("per-page", String(Math.min(maxRecords, 200)));
  const result = await fetchJson(url);
  const payload = recordValue2(result.payload);
  const rows = arrayValue(payload.results).slice(0, maxRecords).map((item) => exactOpenAlexWork(recordValue2(item), booleanValue(parsed.flags.include_abstracts) === true));
  const total = numberValue(recordValue2(payload.meta).count) ?? rows.length;
  return exactOpenAlexOutput({
    search: parsed.text,
    filters: {
      year_from: parsed.flags.year_from,
      year_to: parsed.flags.year_to,
      work_type: parsed.flags.work_type,
      open_access_only: booleanValue(parsed.flags.open_access_only) === true,
      venue: parsed.flags.venue
    },
    sort: parsed.flags.sort ?? "relevance",
    api_total: total,
    n_records_returned: rows.length,
    records_truncated: total > rows.length,
    records: rows
  }, "openalex_search_works", query, [result.endpoint], result.credentialStatus);
}
async function exactGetWork(query, workId) {
  const resolved = await fetchWorkById(workId);
  const record = {
    ...exactOpenAlexWork(resolved.payload, true),
    abstract: reconstructAbstract(resolved.payload.abstract_inverted_index),
    referenced_works: arrayValue(resolved.payload.referenced_works).map(shortOpenAlexId).filter(Boolean),
    counts_by_year: arrayValue(resolved.payload.counts_by_year).slice(0, 12)
  };
  return exactOpenAlexOutput({
    work_id: resolved.workId,
    doi_claimants: resolved.claimants && resolved.claimants.length > 1 ? resolved.claimants : undefined,
    doi_resolution_note: resolved.resolutionNote,
    ...record,
    results: [record]
  }, "openalex_get_work", query, resolved.endpoints, resolved.credentialStatus);
}
async function exactCitations(query, commandQuery, defaultLimit) {
  const parsed = parseKeyValueQuery(commandQuery);
  const workInput = parsed.text;
  if (!workInput)
    throw new Error("openalex_citations requires an OpenAlex work id or DOI.");
  const resolved = await fetchWorkById(workInput);
  const maxRecords = safeExactLimit(numberValue(parsed.flags.max_records), defaultLimit ?? 50);
  const url = endpointPath("/works");
  url.searchParams.set("filter", `cites:${resolved.workId}`);
  const sort = exactSearchSort(parsed.flags.sort ?? "cited_by_count", false);
  if (sort)
    url.searchParams.set("sort", sort);
  url.searchParams.set("per-page", String(Math.min(maxRecords, 200)));
  const result = await fetchJson(url);
  const payload = recordValue2(result.payload);
  const rows = arrayValue(payload.results).slice(0, maxRecords).map((item) => exactOpenAlexWork(recordValue2(item), booleanValue(parsed.flags.include_abstracts) === true));
  const total = numberValue(recordValue2(payload.meta).count) ?? rows.length;
  return exactOpenAlexOutput({
    work_id: resolved.workId,
    doi_claimants: resolved.claimants && resolved.claimants.length > 1 ? resolved.claimants : undefined,
    doi_resolution_note: resolved.resolutionNote,
    api_total: total,
    n_records_returned: rows.length,
    records_truncated: total > rows.length,
    records: rows
  }, "openalex_citations", query, [...resolved.endpoints, result.endpoint], result.credentialStatus);
}
async function exactReferences(query, commandQuery, defaultLimit) {
  const parsed = parseKeyValueQuery(commandQuery);
  if (!parsed.text)
    throw new Error("openalex_references requires an OpenAlex work id or DOI.");
  const resolved = await fetchWorkById(parsed.text);
  const maxRecords = safeExactLimit(numberValue(parsed.flags.max_records), defaultLimit ?? 100);
  const referenceIds = arrayValue(resolved.payload.referenced_works).map(shortOpenAlexId).filter((id) => Boolean(id));
  const selected = referenceIds.slice(0, maxRecords);
  const endpoints = [...resolved.endpoints];
  let credentialStatus = resolved.credentialStatus;
  let rows = [];
  if (selected.length) {
    const hydrateUrl = endpointPath("/works");
    hydrateUrl.searchParams.set("filter", `openalex:${selected.join("|")}`);
    hydrateUrl.searchParams.set("per-page", String(Math.min(selected.length, 200)));
    const hydrated = await fetchJson(hydrateUrl);
    endpoints.push(hydrated.endpoint);
    credentialStatus = hydrated.credentialStatus;
    const order = new Map(selected.map((id, index) => [id, index]));
    rows = arrayValue(recordValue2(hydrated.payload).results).map((item) => exactOpenAlexWork(recordValue2(item), false)).sort((a, b) => (order.get(String(a.openalex_id)) ?? 999) - (order.get(String(b.openalex_id)) ?? 999));
  }
  const got = new Set(rows.map((row) => String(row.openalex_id)));
  return exactOpenAlexOutput({
    work_id: resolved.workId,
    doi_claimants: resolved.claimants && resolved.claimants.length > 1 ? resolved.claimants : undefined,
    doi_resolution_note: resolved.resolutionNote,
    n_references: referenceIds.length,
    n_records_returned: rows.length,
    records_truncated: referenceIds.length > selected.length,
    references_not_hydrated: selected.filter((id) => !got.has(id)),
    reference_ids: referenceIds,
    records: rows
  }, "openalex_references", query, endpoints, credentialStatus);
}
async function exactSearchAuthors(query, commandQuery, defaultLimit) {
  const parsed = parseKeyValueQuery(commandQuery);
  if (!parsed.text)
    throw new Error("openalex_search_authors requires a name query.");
  const maxRecords = safeExactLimit(numberValue(parsed.flags.max_records), defaultLimit ?? 25);
  const url = endpointPath("/authors");
  url.searchParams.set("search", parsed.text);
  url.searchParams.set("per-page", String(Math.min(maxRecords, 200)));
  const result = await fetchJson(url);
  const payload = recordValue2(result.payload);
  const rows = arrayValue(payload.results).slice(0, maxRecords).map((item) => exactAuthor(recordValue2(item)));
  const total = numberValue(recordValue2(payload.meta).count) ?? rows.length;
  return exactOpenAlexOutput({
    search: parsed.text,
    api_total: total,
    n_records_returned: rows.length,
    records_truncated: total > rows.length,
    records: rows
  }, "openalex_search_authors", query, [result.endpoint], result.credentialStatus);
}
async function exactGetAuthor(query, commandQuery) {
  const parsed = parseKeyValueQuery(commandQuery);
  const id = normalizeEntityId(parsed.text, "A");
  if (!id)
    throw new Error("openalex_get_author requires an author id or ORCID.");
  const worksSample = safeExactLimit(numberValue(parsed.flags.works_sample), 10);
  const authorUrl = endpointPath(`/authors/${encodeURIComponent(id)}`);
  const result = await fetchJson(authorUrl);
  const rawAuthor = recordValue2(result.payload);
  const authorId = shortOpenAlexId(rawAuthor.id) ?? id;
  const worksUrl = endpointPath("/works");
  worksUrl.searchParams.set("filter", `author.id:${authorId}`);
  worksUrl.searchParams.set("sort", "cited_by_count:desc");
  worksUrl.searchParams.set("per-page", String(Math.min(worksSample, 200)));
  const works = await fetchJson(worksUrl);
  const workRows = arrayValue(recordValue2(works.payload).results).map((item) => exactOpenAlexWork(recordValue2(item), false));
  return exactOpenAlexOutput({
    ...exactAuthor(rawAuthor),
    counts_by_year: arrayValue(rawAuthor.counts_by_year).slice(0, 12),
    top_works_total: numberValue(recordValue2(recordValue2(works.payload).meta).count) ?? workRows.length,
    top_works: workRows,
    results: [{ ...exactAuthor(rawAuthor), top_works: workRows }]
  }, "openalex_get_author", query, [result.endpoint, works.endpoint], works.credentialStatus);
}
async function exactVenueInfo(query, commandQuery, defaultLimit) {
  const parsed = parseKeyValueQuery(commandQuery);
  const venue = parsed.text;
  if (!venue)
    throw new Error("openalex_venue_info requires a source id, ISSN, or venue name.");
  if (/^S\d+$/i.test(venue) || /^https?:\/\/openalex\.org\/S\d+$/i.test(venue) || /^(?:issn:)?\d{4}-\d{3}[\dXx]$/.test(venue)) {
    const id = normalizeEntityId(venue, "S");
    const url2 = endpointPath(`/sources/${encodeURIComponent(id)}`);
    const result2 = await fetchJson(url2);
    const row = exactSource(recordValue2(result2.payload));
    return exactOpenAlexOutput({
      ...row,
      n_records_returned: 1,
      records: [row]
    }, "openalex_venue_info", query, [result2.endpoint], result2.credentialStatus);
  }
  const maxRecords = safeExactLimit(numberValue(parsed.flags.max_records), defaultLimit ?? 10);
  const url = endpointPath("/sources");
  url.searchParams.set("search", venue);
  url.searchParams.set("per-page", String(Math.min(maxRecords, 200)));
  const result = await fetchJson(url);
  const payload = recordValue2(result.payload);
  const rows = arrayValue(payload.results).slice(0, maxRecords).map((item) => exactSource(recordValue2(item)));
  const total = numberValue(recordValue2(payload.meta).count) ?? rows.length;
  return exactOpenAlexOutput({
    search: venue,
    api_total: total,
    n_records_returned: rows.length,
    records_truncated: total > rows.length,
    records: rows
  }, "openalex_venue_info", query, [result.endpoint], result.credentialStatus);
}
async function searchExactOpenAlex(query, defaultLimit) {
  const command = exactCommand(query);
  if (!command)
    return;
  if (command.name === "openalex_search_works")
    return exactWorkSearch(query, command.rest, defaultLimit);
  if (command.name === "openalex_get_work")
    return exactGetWork(query, command.rest);
  if (command.name === "openalex_citations")
    return exactCitations(query, command.rest, defaultLimit);
  if (command.name === "openalex_references")
    return exactReferences(query, command.rest, defaultLimit);
  if (command.name === "openalex_search_authors")
    return exactSearchAuthors(query, command.rest, defaultLimit);
  if (command.name === "openalex_get_author")
    return exactGetAuthor(query, command.rest);
  if (command.name === "openalex_venue_info")
    return exactVenueInfo(query, command.rest, defaultLimit);
  return;
}

// vendor/upstream/science-database-openalex.ts
var DEFAULT_LIMIT = 5;
var MAX_LIMIT = 20;
var REQUEST_TIMEOUT_MS3 = 25000;
var OPENALEX_BASE2 = "https://api.openalex.org";
var OPEN_ABSTRACT_LICENSES2 = new Set(["cc-by", "cc-by-sa", "cc0", "public-domain"]);
function recordValue3(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function arrayValue2(value) {
  return Array.isArray(value) ? value : [];
}
function stringValue3(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function numberValue2(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return;
}
function booleanValue2(value) {
  if (value === undefined)
    return;
  if (/^(true|1|yes)$/i.test(value))
    return true;
  if (/^(false|0|no)$/i.test(value))
    return false;
  return;
}
function safeLimit(value) {
  if (!Number.isFinite(value) || value === undefined)
    return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT));
}
function cleanQuery2(query) {
  const clean = query.trim();
  if (!clean)
    throw new Error("Science database search requires a non-empty query.");
  return clean;
}
function stripModePrefix(query, pattern) {
  return query.replace(pattern, "").trim();
}
function openAlexDocs2() {
  return [
    "https://developers.openalex.org/api-reference/introduction",
    "https://developers.openalex.org/api-reference/authentication",
    "https://developers.openalex.org/api-reference/works",
    "https://developers.openalex.org/api-entities/works/work-object"
  ];
}
function endpointPath2(path) {
  return new URL(`${OPENALEX_BASE2}${path.startsWith("/") ? path : `/${path}`}`);
}
function openAlexApiKey2() {
  return process.env.OPENALEX_API_KEY?.trim() || undefined;
}
function addAuth2(url) {
  const key = openAlexApiKey2();
  if (key) {
    url.searchParams.set("api_key", key);
    return { credentialStatus: "OPENALEX_API_KEY present", usingApiKey: true };
  }
  return { credentialStatus: `OPENALEX_API_KEY missing. ${OPENALEX_API_KEY_HINT}`, usingApiKey: false };
}
function scrubOpenAlexEndpoint2(url) {
  const clean = new URL(url.toString());
  if (clean.searchParams.has("api_key"))
    clean.searchParams.set("api_key", "[redacted]");
  return clean.toString();
}
function scrubOpenAlexText2(text, url) {
  const key = url.searchParams.get("api_key");
  if (!key || key.length < 6)
    return text;
  let scrubbed = text;
  for (const form of [key, encodeURIComponent(key), encodeURIComponent(encodeURIComponent(key))]) {
    scrubbed = scrubbed.split(form).join("[redacted]");
  }
  return scrubbed;
}
var semanticPacer = createRequestPacer();
var SEMANTIC_MIN_GAP_MS = 1100;
var MAX_RETRY_WAIT_MS = 5000;
async function requestOnce(url) {
  const controller = new AbortController;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS3);
  try {
    const response = await researchFetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "feynman-science-database-search/1.0 (https://github.com/Companion-Inc/feynman)"
      },
      signal: controller.signal
    });
    if (response.ok)
      return { ok: true, payload: await response.json() };
    const retryAfter = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    return {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : undefined,
      body: (await response.text()).slice(0, 4096)
    };
  } finally {
    clearTimeout(timeout);
  }
}
async function fetchJson2(url) {
  const auth = addAuth2(url);
  const endpoint = scrubOpenAlexEndpoint2(url);
  const request = () => url.searchParams.has("search.semantic") ? semanticPacer(SEMANTIC_MIN_GAP_MS, () => requestOnce(url)) : requestOnce(url);
  let response = await request();
  if (!response.ok && response.status === 429 && response.retryAfterMs !== undefined && response.retryAfterMs <= MAX_RETRY_WAIT_MS) {
    const waitMs = response.retryAfterMs + Math.random() * 500;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await request();
  }
  if (!response.ok) {
    const snippet = scrubOpenAlexText2(response.body, url).slice(0, 240);
    throw openAlexRequestFailure(response.status, response.statusText, snippet, auth.usingApiKey, url);
  }
  return { ...auth, endpoint, payload: response.payload };
}
function shortOpenAlexId2(value) {
  const raw = stringValue3(value);
  if (!raw)
    return;
  return raw.split("/").pop() || raw;
}
function doiValue2(value) {
  const raw = stringValue3(value);
  if (!raw)
    return;
  return raw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}
function externalId2(value) {
  const raw = stringValue3(value);
  if (!raw)
    return;
  return raw.split("/").pop() || raw;
}
function reconstructAbstract2(index) {
  const inverted = recordValue3(index);
  const positions = [];
  for (const [word, rawPositions] of Object.entries(inverted)) {
    for (const position of arrayValue2(rawPositions)) {
      const numeric = numberValue2(position);
      if (numeric !== undefined)
        positions.push({ position: numeric, word });
    }
  }
  if (!positions.length)
    return;
  return positions.sort((a, b) => a.position - b.position).map((item) => item.word).join(" ");
}
function workLicense2(work) {
  for (const locationKey of ["primary_location", "best_oa_location"]) {
    const raw = stringValue3(recordValue3(work[locationKey]).license);
    if (raw)
      return raw.split("/").pop()?.toLowerCase() || raw.toLowerCase();
  }
  return;
}
function normalizeAuthorship2(value) {
  const authorship = recordValue3(value);
  const author = recordValue3(authorship.author);
  return {
    authorId: shortOpenAlexId2(author.id),
    name: stringValue3(author.display_name),
    orcid: stringValue3(author.orcid),
    position: stringValue3(authorship.author_position),
    isCorresponding: authorship.is_corresponding === true,
    institutions: arrayValue2(authorship.institutions).map((item) => stringValue3(recordValue3(item).display_name)).filter(Boolean).slice(0, 6)
  };
}
function normalizeOpenAlexWork2(work, includeAbstract) {
  const id = shortOpenAlexId2(work.id);
  const ids = recordValue3(work.ids);
  const primary = recordValue3(work.primary_location);
  const bestOa = recordValue3(work.best_oa_location);
  const source = recordValue3(primary.source);
  const openAccess = recordValue3(work.open_access);
  const topic = recordValue3(work.primary_topic);
  const license = workLicense2(work);
  const abstract = includeAbstract && license && OPEN_ABSTRACT_LICENSES2.has(license) ? reconstructAbstract2(work.abstract_inverted_index) : undefined;
  return {
    openalexId: id,
    url: id ? `https://openalex.org/${id}` : stringValue3(work.id),
    doi: doiValue2(work.doi ?? ids.doi),
    pmid: externalId2(ids.pmid),
    pmcid: externalId2(ids.pmcid),
    title: stringValue3(work.title) ?? stringValue3(work.display_name),
    publicationYear: numberValue2(work.publication_year),
    publicationDate: stringValue3(work.publication_date),
    type: stringValue3(work.type),
    language: stringValue3(work.language),
    isRetracted: work.is_retracted === true,
    authors: arrayValue2(work.authorships).map(normalizeAuthorship2).slice(0, 12),
    source: source.id || source.display_name ? {
      sourceId: shortOpenAlexId2(source.id),
      displayName: stringValue3(source.display_name),
      issnL: stringValue3(source.issn_l),
      type: stringValue3(source.type)
    } : undefined,
    biblio: recordValue3(work.biblio),
    citedByCount: numberValue2(work.cited_by_count),
    fwci: numberValue2(work.fwci),
    referencedWorksCount: numberValue2(work.referenced_works_count),
    openAccess: {
      isOpenAccess: openAccess.is_oa === true,
      status: stringValue3(openAccess.oa_status),
      url: stringValue3(openAccess.oa_url)
    },
    bestOaPdfUrl: stringValue3(bestOa.pdf_url),
    primaryTopic: stringValue3(topic.display_name),
    keywords: arrayValue2(work.keywords).map((item) => stringValue3(recordValue3(item).display_name)).filter(Boolean).slice(0, 8),
    abstract,
    abstractLicense: license,
    abstractPolicy: includeAbstract && !abstract ? "Abstract omitted unless OpenAlex exposes a declared open license and an inverted index." : undefined
  };
}
function normalizeAuthor2(author) {
  const id = shortOpenAlexId2(author.id);
  const summaryStats = recordValue3(author.summary_stats);
  return {
    authorId: id,
    url: id ? `https://openalex.org/${id}` : stringValue3(author.id),
    name: stringValue3(author.display_name),
    orcid: stringValue3(author.orcid),
    worksCount: numberValue2(author.works_count),
    citedByCount: numberValue2(author.cited_by_count),
    hIndex: numberValue2(summaryStats.h_index),
    i10Index: numberValue2(summaryStats.i10_index),
    lastKnownInstitutions: arrayValue2(author.last_known_institutions).map((item) => stringValue3(recordValue3(item).display_name)).filter(Boolean).slice(0, 6),
    topics: arrayValue2(author.topics).map((item) => stringValue3(recordValue3(item).display_name)).filter(Boolean).slice(0, 8)
  };
}
function normalizeSource2(source) {
  const id = shortOpenAlexId2(source.id);
  const summaryStats = recordValue3(source.summary_stats);
  return {
    sourceId: id,
    url: id ? `https://openalex.org/${id}` : stringValue3(source.id),
    displayName: stringValue3(source.display_name),
    issnL: stringValue3(source.issn_l),
    issn: arrayValue2(source.issn).map(String).filter(Boolean),
    type: stringValue3(source.type),
    worksCount: numberValue2(source.works_count),
    citedByCount: numberValue2(source.cited_by_count),
    hIndex: numberValue2(summaryStats.h_index),
    i10Index: numberValue2(summaryStats.i10_index),
    isOa: source.is_oa === true,
    homepageUrl: stringValue3(source.homepage_url)
  };
}
function parseKeyValueQuery2(query) {
  const flags = {};
  const textParts = [];
  for (const part of query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const match = part.match(/^([a-z_]+)=(.+)$/i);
    if (match?.[1] && match[2] !== undefined)
      flags[match[1].toLowerCase()] = match[2].replace(/^"|"$/g, "");
    else
      textParts.push(part);
  }
  return { flags, text: textParts.join(" ").replace(/^"|"$/g, "").trim() };
}
function sortParam(value, hasSearch) {
  if (value === "cited_by_count")
    return "cited_by_count:desc";
  if (value === "publication_date" || value === "pub_date")
    return "publication_date:desc";
  if (value === "relevance" && hasSearch)
    return "relevance_score:desc";
  return;
}
function normalizeWorkId2(value) {
  const clean = value.trim();
  const openAlexUrl = clean.match(/^https?:\/\/openalex\.org\/(W\d+)$/i);
  if (openAlexUrl?.[1])
    return openAlexUrl[1].toUpperCase();
  const doiUrl2 = clean.match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\..+)$/i);
  if (doiUrl2?.[1])
    return `doi:${doiUrl2[1]}`;
  if (/^doi:\s*10\./i.test(clean))
    return `doi:${clean.replace(/^doi:\s*/i, "")}`;
  if (/^10\..+\/.+/.test(clean))
    return `doi:${clean}`;
  if (/^W\d+$/i.test(clean))
    return clean.toUpperCase();
  return clean;
}
function normalizeEntityId2(value, prefix) {
  const clean = value.trim();
  const openAlexUrl = clean.match(new RegExp(`^https?://openalex\\.org/(${prefix}\\d+)$`, "i"));
  if (openAlexUrl?.[1])
    return openAlexUrl[1].toUpperCase();
  if (new RegExp(`^${prefix}\\d+$`, "i").test(clean))
    return clean.toUpperCase();
  if (prefix === "S" && /^(?:issn:)?\d{4}-\d{3}[\dXx]$/.test(clean))
    return clean.replace(/^issn:/i, "").toUpperCase();
  return clean;
}
function withMeta(payload, mode, query, endpoints, credentialStatus) {
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "openalex",
    query,
    mode,
    credentialStatus,
    provenance: { docs: openAlexDocs2(), endpoints },
    ...payload
  };
}
function doiClaimants2(results) {
  return results.map((item) => {
    const work = recordValue3(item);
    return {
      openalexId: shortOpenAlexId2(work.id),
      title: stringValue3(work.title) ?? stringValue3(work.display_name),
      publicationYear: numberValue2(work.publication_year),
      citedByCount: numberValue2(work.cited_by_count)
    };
  });
}
async function resolveDoiWork2(doiWorkId) {
  const doi = doiWorkId.replace(/^doi:/i, "");
  const url = endpointPath2("/works");
  url.searchParams.set("filter", `doi:${doi}`);
  url.searchParams.set("sort", "cited_by_count:desc");
  url.searchParams.set("per-page", "20");
  const result = await fetchJson2(url);
  const rows = arrayValue2(recordValue3(result.payload).results).map(recordValue3).sort((a, b) => (numberValue2(b.cited_by_count) ?? 0) - (numberValue2(a.cited_by_count) ?? 0));
  if (!rows.length)
    throw new Error(`OpenAlex has no work for doi:${doi}`);
  const claimants = doiClaimants2(rows);
  const workId = shortOpenAlexId2(rows[0]?.id) ?? doiWorkId;
  return {
    claimants,
    credentialStatus: result.credentialStatus,
    endpoints: [result.endpoint],
    payload: rows[0] ?? {},
    resolutionNote: claimants.length > 1 ? `${claimants.length} OpenAlex works claim doi:${doi}; selected the most-cited claimant ${workId}.` : undefined,
    workId
  };
}
async function searchOpenAlex(params) {
  const query = cleanQuery2(params.query);
  const limit = safeLimit(params.limit);
  const exact = await searchExactOpenAlex(query, limit);
  if (exact)
    return exact;
  if (/^rate-limit$/i.test(query)) {
    if (!openAlexApiKey2()) {
      return withMeta({
        error: "openalex_key_required",
        message: `Set OPENALEX_API_KEY to check OpenAlex rate-limit and usage status. ${OPENALEX_API_KEY_HINT}`,
        totalCount: 0,
        returned: 0,
        results: [],
        anonymousBudgetWarning: "OpenAlex rate-limit diagnostics require OPENALEX_API_KEY."
      }, "rate-limit", query, [], `OPENALEX_API_KEY missing. ${OPENALEX_API_KEY_HINT}`);
    }
    const url2 = endpointPath2("/rate-limit");
    const result2 = await fetchJson2(url2);
    return withMeta({
      totalCount: 1,
      returned: 1,
      results: [recordValue3(result2.payload)]
    }, "rate-limit", query, [result2.endpoint], result2.credentialStatus);
  }
  if (/^(?:authors|author-search)(?::|\s+)/i.test(query)) {
    const term = stripModePrefix(query, /^(?:authors|author-search)(?::|\s+)/i);
    const url2 = endpointPath2("/authors");
    url2.searchParams.set("search", term);
    url2.searchParams.set("per-page", String(limit));
    const result2 = await fetchJson2(url2);
    const payload2 = recordValue3(result2.payload);
    const rows2 = arrayValue2(payload2.results).map((item) => normalizeAuthor2(recordValue3(item)));
    return withMeta({
      totalCount: numberValue2(recordValue3(payload2.meta).count) ?? rows2.length,
      returned: rows2.length,
      results: rows2
    }, "author-search", query, [result2.endpoint], result2.credentialStatus);
  }
  if (/^author(?::|\s+)/i.test(query)) {
    const rawId = stripModePrefix(query, /^author(?::|\s+)/i);
    const id = normalizeEntityId2(rawId, "A");
    const url2 = endpointPath2(`/authors/${encodeURIComponent(id)}`);
    const result2 = await fetchJson2(url2);
    return withMeta({
      authorId: id,
      totalCount: 1,
      returned: 1,
      results: [normalizeAuthor2(recordValue3(result2.payload))]
    }, "author-detail", query, [result2.endpoint], result2.credentialStatus);
  }
  if (/^(?:sources|venues?)(?::|\s+)/i.test(query)) {
    const term = stripModePrefix(query, /^(?:sources|venues?)(?::|\s+)/i);
    const url2 = endpointPath2("/sources");
    url2.searchParams.set("search", term);
    url2.searchParams.set("per-page", String(limit));
    const result2 = await fetchJson2(url2);
    const payload2 = recordValue3(result2.payload);
    const rows2 = arrayValue2(payload2.results).map((item) => normalizeSource2(recordValue3(item)));
    return withMeta({
      totalCount: numberValue2(recordValue3(payload2.meta).count) ?? rows2.length,
      returned: rows2.length,
      results: rows2
    }, "source-search", query, [result2.endpoint], result2.credentialStatus);
  }
  if (/^source(?::|\s+)/i.test(query)) {
    const rawId = stripModePrefix(query, /^source(?::|\s+)/i);
    const id = normalizeEntityId2(rawId, "S");
    const url2 = endpointPath2(`/sources/${encodeURIComponent(id)}`);
    const result2 = await fetchJson2(url2);
    return withMeta({
      sourceId: id,
      totalCount: 1,
      returned: 1,
      results: [normalizeSource2(recordValue3(result2.payload))]
    }, "source-detail", query, [result2.endpoint], result2.credentialStatus);
  }
  if (/^citations?(?::|\s+)/i.test(query)) {
    const inputWorkId = normalizeWorkId2(stripModePrefix(query, /^citations?(?::|\s+)/i));
    const resolved = /^doi:10\./i.test(inputWorkId) ? await resolveDoiWork2(inputWorkId) : undefined;
    const workId = resolved?.workId ?? inputWorkId;
    const url2 = endpointPath2("/works");
    url2.searchParams.set("filter", `cites:${workId}`);
    url2.searchParams.set("sort", "cited_by_count:desc");
    url2.searchParams.set("per-page", String(limit));
    const result2 = await fetchJson2(url2);
    const payload2 = recordValue3(result2.payload);
    const rows2 = arrayValue2(payload2.results).map((item) => normalizeOpenAlexWork2(recordValue3(item), false));
    return withMeta({
      workId,
      doiClaimants: resolved && resolved.claimants.length > 1 ? resolved.claimants : undefined,
      doiResolutionNote: resolved?.resolutionNote,
      totalCount: numberValue2(recordValue3(payload2.meta).count) ?? rows2.length,
      returned: rows2.length,
      recordsTruncated: (numberValue2(recordValue3(payload2.meta).count) ?? rows2.length) > rows2.length,
      results: rows2
    }, "citations", query, [...resolved?.endpoints ?? [], result2.endpoint], result2.credentialStatus);
  }
  if (/^references?(?::|\s+)/i.test(query)) {
    const inputWorkId = normalizeWorkId2(stripModePrefix(query, /^references?(?::|\s+)/i));
    const resolved = /^doi:10\./i.test(inputWorkId) ? await resolveDoiWork2(inputWorkId) : undefined;
    const workId = resolved?.workId ?? inputWorkId;
    let detail;
    if (!resolved) {
      const detailUrl = endpointPath2(`/works/${encodeURIComponent(workId)}`);
      detailUrl.searchParams.set("select", "id,referenced_works");
      detail = await fetchJson2(detailUrl);
    }
    const referenceIds = arrayValue2(recordValue3(resolved?.payload ?? detail?.payload).referenced_works).map(shortOpenAlexId2).filter((id) => Boolean(id));
    const selected = referenceIds.slice(0, limit);
    const endpoints = [...resolved?.endpoints ?? [], ...detail ? [detail.endpoint] : []];
    let rows2 = [];
    let credentialStatus = resolved?.credentialStatus ?? detail?.credentialStatus ?? "";
    if (selected.length) {
      const hydrateUrl = endpointPath2("/works");
      hydrateUrl.searchParams.set("filter", `openalex:${selected.join("|")}`);
      hydrateUrl.searchParams.set("per-page", String(selected.length));
      const hydrated = await fetchJson2(hydrateUrl);
      endpoints.push(hydrated.endpoint);
      credentialStatus = hydrated.credentialStatus;
      const order = new Map(selected.map((id, index) => [id, index]));
      rows2 = arrayValue2(recordValue3(hydrated.payload).results).map((item) => normalizeOpenAlexWork2(recordValue3(item), false)).sort((a, b) => (order.get(String(a.openalexId)) ?? 999) - (order.get(String(b.openalexId)) ?? 999));
    }
    const got = new Set(rows2.map((row) => String(row.openalexId)));
    return withMeta({
      workId,
      doiClaimants: resolved && resolved.claimants.length > 1 ? resolved.claimants : undefined,
      doiResolutionNote: resolved?.resolutionNote,
      referenceIds,
      referencesNotHydrated: selected.filter((id) => !got.has(id)),
      totalCount: referenceIds.length,
      returned: rows2.length,
      recordsTruncated: referenceIds.length > selected.length,
      results: rows2
    }, "references", query, endpoints, credentialStatus);
  }
  const detailMatch = /^(?:work|detail)(?::|\s+)(.+)$/i.exec(query);
  const detailCandidate = normalizeWorkId2(detailMatch?.[1] ?? query);
  if (/^(?:W\d+|doi:10\..+|10\..+\/.+)$/i.test(detailCandidate)) {
    const resolved = /^doi:10\./i.test(detailCandidate) ? await resolveDoiWork2(detailCandidate) : undefined;
    const result2 = resolved ? undefined : await fetchJson2(endpointPath2(`/works/${encodeURIComponent(detailCandidate)}`));
    const payload2 = recordValue3(resolved?.payload ?? result2?.payload);
    return withMeta({
      workId: shortOpenAlexId2(payload2.id) ?? resolved?.workId ?? detailCandidate,
      doiClaimants: resolved && resolved.claimants.length > 1 ? resolved.claimants : undefined,
      doiResolutionNote: resolved?.resolutionNote,
      totalCount: 1,
      returned: 1,
      results: [{
        ...normalizeOpenAlexWork2(payload2, true),
        referencedWorks: arrayValue2(payload2.referenced_works).map(shortOpenAlexId2).filter(Boolean),
        countsByYear: arrayValue2(payload2.counts_by_year).slice(0, 12)
      }]
    }, "work-detail", query, resolved?.endpoints ?? (result2 ? [result2.endpoint] : []), resolved?.credentialStatus ?? result2?.credentialStatus ?? "");
  }
  const semantic = /^semantic(?::|\s+)/i.test(query);
  const parsed = parseKeyValueQuery2(stripModePrefix(query, semantic ? /^semantic(?::|\s+)/i : /^search(?::|\s+)/i));
  const url = endpointPath2("/works");
  if (parsed.text)
    url.searchParams.set(semantic ? "search.semantic" : "search", parsed.text);
  const filters = [];
  if (parsed.flags.year_from && parsed.flags.year_to)
    filters.push(`publication_year:${parsed.flags.year_from}-${parsed.flags.year_to}`);
  else if (parsed.flags.year_from)
    filters.push(`publication_year:>${Number(parsed.flags.year_from) - 1}`);
  else if (parsed.flags.year_to)
    filters.push(`publication_year:<${Number(parsed.flags.year_to) + 1}`);
  if (parsed.flags.type)
    filters.push(`type:${parsed.flags.type}`);
  if (booleanValue2(parsed.flags.oa ?? parsed.flags.open_access) === true)
    filters.push("open_access.is_oa:true");
  if (parsed.flags.source)
    filters.push(`primary_location.source.id:${normalizeEntityId2(parsed.flags.source, "S")}`);
  if (filters.length)
    url.searchParams.set("filter", filters.join(","));
  if (semantic && !parsed.text)
    throw new Error("OpenAlex semantic search requires query text.");
  const sort = semantic ? undefined : sortParam(parsed.flags.sort ?? "relevance", Boolean(parsed.text));
  if (sort)
    url.searchParams.set("sort", sort);
  if (!parsed.text && !filters.length)
    throw new Error("OpenAlex work search requires text or filters.");
  url.searchParams.set("per-page", String(limit));
  const result = await fetchJson2(url);
  const payload = recordValue3(result.payload);
  const rows = arrayValue2(payload.results).map((item) => normalizeOpenAlexWork2(recordValue3(item), booleanValue2(parsed.flags.abstracts) === true));
  return withMeta({
    search: parsed.text,
    filters,
    sort: semantic ? "semantic" : parsed.flags.sort ?? "relevance",
    totalCount: numberValue2(recordValue3(payload.meta).count) ?? rows.length,
    returned: rows.length,
    recordsTruncated: (numberValue2(recordValue3(payload.meta).count) ?? rows.length) > rows.length,
    anonymousBudgetWarning: openAlexApiKey2() ? undefined : OPENALEX_API_KEY_HINT,
    results: rows
  }, semantic ? "work-semantic-search" : "work-search", query, [result.endpoint], result.credentialStatus);
}

// vendor/upstream/alpha.ts
function formatText(value) {
  if (typeof value === "string")
    return value;
  return JSON.stringify(value, null, 2);
}
var ARXIV_ID = /(?:^|arxiv\.org\/(?:abs|pdf)\/|alphaxiv\.org\/(?:abs|overview)\/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;
async function withPaperFallback(run, fallback) {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (fallback) {
      try {
        return { fallbackNote: `alphaXiv did not answer (${message}); these results are from ${fallback.source}.`, ...await fallback.run() };
      } catch {}
    }
    throw new Error(`${message}
alphaXiv did not answer this call. Use feynman_science_database_search (source "arxiv" or "semanticscholar") or feynman_fetch_content on https://arxiv.org/abs/<id> instead.`);
  }
}
var paperSectionsSchema = Type.Unsafe({
  type: "array",
  items: Type.String({
    description: "Multiple sections to extract from content. Supported values: abstract, introduction, methodology, experiments, results, discussion, limitations, conclusion."
  })
});
function registerAlphaTools(pi, signedIn = isLoggedIn()) {
  pi.on("session_shutdown", async () => {
    await disconnect();
  });
  const registerAccountTool = signedIn ? (tool) => pi.registerTool(tool) : () => {};
  registerAccountTool({
    name: "alpha_search",
    label: "Alpha Search",
    description: "Search research papers through alphaXiv. Modes: semantic (default, use 2-3 sentence queries), keyword (exact terms), agentic (broad multi-turn retrieval), both, or all.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      mode: Type.Optional(Type.String({ description: "Search mode: semantic, keyword, both, agentic, or all." }))
    }),
    async execute(_toolCallId, params) {
      const result = await withPaperFallback(() => searchPapers(params.query, params.mode?.trim() || "semantic"), {
        source: "OpenAlex semantic search",
        run: () => searchOpenAlex({ source: "openalex", query: `semantic: ${params.query}`, limit: 10 })
      });
      return { content: [{ type: "text", text: formatText(result) }], details: result };
    }
  });
  registerAccountTool({
    name: "alpha_get_paper",
    label: "Alpha Get Paper",
    description: "Fetch a paper's AI-generated report (or raw full text) plus any local annotation. Optional section filters return only requested sections when detectable.",
    parameters: Type.Object({
      paper: Type.String({ description: "arXiv ID, arXiv URL, or alphaXiv URL." }),
      fullText: Type.Optional(Type.Boolean({ description: "Return raw full text instead of AI report." })),
      section: Type.Optional(Type.String({
        description: "Single section to extract from content: abstract, introduction, methodology, experiments, results, discussion, limitations, or conclusion."
      })),
      sections: Type.Optional(paperSectionsSchema)
    }),
    async execute(_toolCallId, params) {
      const arxivId = ARXIV_ID.exec(params.paper.trim())?.[1];
      const result = await withPaperFallback(() => getPaper(params.paper, { fullText: params.fullText }), arxivId ? {
        source: "arXiv metadata and abstract (no full text or sections)",
        run: () => searchArxiv({ query: arxivId })
      } : undefined);
      if ("fallbackNote" in result) {
        return { content: [{ type: "text", text: formatText(result) }], details: result };
      }
      const extracted = extractPaperSections(result.content, params.section, params.sections);
      const filteredResult = extracted.requested.length ? {
        ...result,
        content: Object.keys(extracted.selected).length > 0 ? extracted.selected : result.content,
        requestedSections: extracted.requested,
        missingSections: extracted.missing
      } : result;
      return { content: [{ type: "text", text: formatText(filteredResult) }], details: filteredResult };
    }
  });
  registerAccountTool({
    name: "alpha_ask_paper",
    label: "Alpha Ask Paper",
    description: "Ask a targeted question about an arXiv or alphaXiv paper. Uses AI to analyze the PDF and answer. DOI-only papers are not supported; read those with feynman_fetch_content on the open-access PDF or Europe PMC full text.",
    parameters: Type.Object({
      paper: Type.String({ description: "arXiv ID, arXiv URL, or alphaXiv URL." }),
      question: Type.String({ description: "Question about the paper." })
    }),
    async execute(_toolCallId, params) {
      const arxivId = ARXIV_ID.exec(params.paper.trim())?.[1];
      const result = await withPaperFallback(() => askPaper(params.paper, params.question), arxivId ? {
        source: "arXiv metadata and abstract; the question was not answered, so answer it from the abstract or read the full text with feynman_fetch_content on the arXiv PDF",
        run: () => searchArxiv({ query: arxivId })
      } : undefined);
      return { content: [{ type: "text", text: formatText(result) }], details: result };
    }
  });
  pi.registerTool({
    name: "alpha_annotate_paper",
    label: "Alpha Annotate Paper",
    description: "Write or clear a persistent local annotation for a paper.",
    parameters: Type.Object({
      paper: Type.String({ description: "Paper ID (arXiv ID or URL)." }),
      note: Type.Optional(Type.String({ description: "Annotation text. Omit when clear=true." })),
      clear: Type.Optional(Type.Boolean({ description: "Clear the existing annotation." }))
    }),
    async execute(_toolCallId, params) {
      const result = params.clear ? await clearPaperAnnotation(params.paper) : params.note ? await annotatePaper(params.paper, params.note) : (() => {
        throw new Error("Provide either note or clear=true.");
      })();
      return { content: [{ type: "text", text: formatText(result) }], details: result };
    }
  });
  pi.registerTool({
    name: "alpha_list_annotations",
    label: "Alpha List Annotations",
    description: "List all persistent local paper annotations.",
    parameters: Type.Object({}),
    async execute() {
      const result = await listPaperAnnotations();
      return { content: [{ type: "text", text: formatText(result) }], details: result };
    }
  });
  registerAccountTool({
    name: "alpha_read_code",
    label: "Alpha Read Code",
    description: "Read files from a paper's GitHub repository. Use '/' for repo overview.",
    parameters: Type.Object({
      githubUrl: Type.String({ description: "GitHub repository URL." }),
      path: Type.Optional(Type.String({ description: "File or directory path. Default: '/'" }))
    }),
    async execute(_toolCallId, params) {
      const result = await readPaperCode(params.githubUrl, params.path?.trim() || "/");
      return { content: [{ type: "text", text: formatText(result) }], details: result };
    }
  });
}
// vendor/upstream/huggingface.ts
import { Type as Type2 } from "typebox";
var HF_API_BASE = "https://huggingface.co/api";
var HF_BASE = "https://huggingface.co";
var DEFAULT_FILE_LIMIT = 200;
var DEFAULT_READ_CHARS = 20000;
var MAX_READ_CHARS = 60000;
var BLOCKED_FILE_EXTENSIONS = new Set([
  ".7z",
  ".bin",
  ".ckpt",
  ".gguf",
  ".h5",
  ".joblib",
  ".onnx",
  ".ot",
  ".parquet",
  ".pt",
  ".pth",
  ".safetensors",
  ".tar",
  ".tgz",
  ".zip"
]);
function encodeRepoId(repo) {
  return repo.split("/").map((part) => encodeURIComponent(part)).join("/");
}
function repoTypeApiSegment(repoType) {
  return repoType === "model" ? "models" : repoType === "dataset" ? "datasets" : "spaces";
}
function repoTypeResolvePrefix(repoType) {
  return repoType === "model" ? "" : repoType === "dataset" ? "datasets/" : "spaces/";
}
function authHeaders() {
  const token = process.env.HF_TOKEN ?? process.env.HUGGINGFACE_HUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function fetchJson3(url) {
  const response = await researchFetch(url, { headers: authHeaders() });
  if (!response.ok) {
    throw new Error(`Hugging Face request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
function trimText(value, maxChars) {
  if (value.length <= maxChars)
    return value;
  return `${value.slice(0, maxChars)}

[truncated: ${value.length - maxChars} chars omitted]`;
}
function safeNumber(value, fallback, max) {
  if (!Number.isFinite(value) || value === undefined)
    return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}
function formatText2(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function fileExtension(path) {
  const fileName = path.split("/").pop() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}
function assertReadableHubFile(path) {
  const extension = fileExtension(path);
  if (BLOCKED_FILE_EXTENSIONS.has(extension)) {
    throw new Error(`Refusing to read likely large or binary Hugging Face file: ${path}`);
  }
}
function extractDatasetInfo(cardData) {
  if (!cardData || typeof cardData !== "object")
    return;
  const record = cardData;
  return record.dataset_info ?? record.dataset_infos;
}
async function datasetInfo(dataset) {
  const encoded = encodeRepoId(dataset.trim());
  const data = await fetchJson3(`${HF_API_BASE}/datasets/${encoded}`);
  const record = data;
  return {
    id: record.id,
    author: record.author,
    sha: record.sha,
    lastModified: record.lastModified,
    private: record.private,
    gated: record.gated,
    disabled: record.disabled,
    downloads: record.downloads,
    likes: record.likes,
    tags: record.tags,
    cardData: record.cardData,
    datasetInfo: extractDatasetInfo(record.cardData),
    siblings: record.siblings,
    url: `${HF_BASE}/datasets/${encoded}`
  };
}
async function repoFiles(params) {
  const encoded = encodeRepoId(params.repo.trim());
  const revision = encodeURIComponent(params.revision?.trim() || "main");
  const cleanPath = params.path?.trim().replace(/^\/+/, "");
  const pathSuffix = cleanPath ? `/${cleanPath.split("/").map(encodeURIComponent).join("/")}` : "";
  const query = new URLSearchParams({ recursive: params.recursive ? "true" : "false" });
  const url = `${HF_API_BASE}/${repoTypeApiSegment(params.repoType)}/${encoded}/tree/${revision}${pathSuffix}?${query}`;
  const data = await fetchJson3(url);
  const files = Array.isArray(data) ? data : [];
  const limit = safeNumber(params.limit, DEFAULT_FILE_LIMIT, 1000);
  return {
    repo: params.repo,
    repoType: params.repoType,
    revision: params.revision || "main",
    path: cleanPath || "",
    count: files.length,
    truncated: files.length > limit,
    files: files.slice(0, limit),
    url: `${HF_BASE}/${repoTypeResolvePrefix(params.repoType)}${encoded}/tree/${revision}${pathSuffix}`
  };
}
async function readRepoFile(params) {
  const encoded = encodeRepoId(params.repo.trim());
  const revision = encodeURIComponent(params.revision?.trim() || "main");
  const cleanPath = params.path.trim().replace(/^\/+/, "");
  assertReadableHubFile(cleanPath);
  const filePath = cleanPath.split("/").map(encodeURIComponent).join("/");
  const url = `${HF_BASE}/${repoTypeResolvePrefix(params.repoType)}${encoded}/resolve/${revision}/${filePath}`;
  const response = await researchFetch(url, { headers: authHeaders() });
  if (!response.ok) {
    throw new Error(`Hugging Face file read failed: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const maxChars = safeNumber(params.maxChars, DEFAULT_READ_CHARS, MAX_READ_CHARS);
  return {
    repo: params.repo,
    repoType: params.repoType,
    revision: params.revision || "main",
    path: cleanPath,
    contentType,
    sizeChars: text.length,
    truncated: text.length > maxChars,
    content: trimText(text, maxChars),
    url
  };
}
function registerHuggingFaceTools(pi) {
  const repoTypeSchema = Type2.Optional(Type2.Union([Type2.Literal("model"), Type2.Literal("dataset"), Type2.Literal("space")], {
    description: "Hub repository type. Defaults to dataset."
  }));
  pi.registerTool({
    name: "hf_dataset_info",
    label: "HF Dataset Info",
    description: "Inspect Hugging Face dataset metadata, tags, card data, dataset_info features, splits, and sibling files. Uses HF_TOKEN or HUGGINGFACE_HUB_TOKEN when set.",
    promptSnippet: "Inspect Hugging Face dataset metadata, features, splits, tags, access status, and sibling files.",
    promptGuidelines: [
      "Use hf_dataset_info before calling a Hugging Face dataset usable in an ML recipe or replication plan.",
      "Treat hf_dataset_info feature and split details as evidence; if they are missing, mark schema or availability as unverified."
    ],
    parameters: Type2.Object({
      dataset: Type2.String({ description: "Dataset repo id, for example HuggingFaceH4/ultrachat_200k." })
    }),
    async execute(_toolCallId, params) {
      const result = await datasetInfo(params.dataset);
      return { content: [{ type: "text", text: formatText2(result) }], details: result };
    }
  });
  pi.registerTool({
    name: "hf_repo_files",
    label: "HF Repo Files",
    description: "List files in a Hugging Face model, dataset, or Space repo. Use this before reading files so large artifacts can be avoided.",
    promptSnippet: "List files in a Hugging Face model, dataset, or Space repository before reading specific small files.",
    promptGuidelines: [
      "Use hf_repo_files before hf_repo_read_file so large model weights, archives, and dataset shards can be avoided."
    ],
    parameters: Type2.Object({
      repo: Type2.String({ description: "Hub repo id, for example HuggingFaceH4/ultrachat_200k or openai-community/gpt2." }),
      repoType: repoTypeSchema,
      revision: Type2.Optional(Type2.String({ description: "Git revision, branch, tag, or commit. Defaults to main." })),
      path: Type2.Optional(Type2.String({ description: "Optional subdirectory path." })),
      recursive: Type2.Optional(Type2.Boolean({ description: "Whether to list recursively. Defaults to false." })),
      limit: Type2.Optional(Type2.Number({ description: "Maximum file entries to return. Defaults to 200, max 1000." }))
    }),
    async execute(_toolCallId, params) {
      const result = await repoFiles({
        repo: params.repo,
        repoType: params.repoType ?? "dataset",
        revision: params.revision,
        path: params.path,
        recursive: params.recursive,
        limit: params.limit
      });
      return { content: [{ type: "text", text: formatText2(result) }], details: result };
    }
  });
  pi.registerTool({
    name: "hf_repo_read_file",
    label: "HF Read File",
    description: "Read a small text file from a Hugging Face model, dataset, or Space repo. Use for README, configs, dataset cards, examples, and scripts; avoid large data or weight files.",
    promptSnippet: "Read small text files from Hugging Face repos, such as README.md, configs, examples, and scripts.",
    promptGuidelines: [
      "Use hf_repo_read_file only for small text files from Hugging Face repos; do not use it for weights, archives, or dataset shards."
    ],
    parameters: Type2.Object({
      repo: Type2.String({ description: "Hub repo id, for example HuggingFaceH4/ultrachat_200k or openai-community/gpt2." }),
      repoType: repoTypeSchema,
      path: Type2.String({ description: "File path inside the repo, for example README.md or config.json." }),
      revision: Type2.Optional(Type2.String({ description: "Git revision, branch, tag, or commit. Defaults to main." })),
      maxChars: Type2.Optional(Type2.Number({ description: "Maximum characters to return. Defaults to 20000, max 60000." }))
    }),
    async execute(_toolCallId, params) {
      const result = await readRepoFile({
        repo: params.repo,
        repoType: params.repoType ?? "dataset",
        path: params.path,
        revision: params.revision,
        maxChars: params.maxChars
      });
      return { content: [{ type: "text", text: formatText2(result) }], details: result };
    }
  });
}
// vendor/upstream/science-databases.ts
import { Type as Type3 } from "typebox";

// vendor/upstream/science-database-preprints.ts
var PREPRINT_API_BASE = "https://api.biorxiv.org";
var DEFAULT_LIMIT2 = 5;
var MAX_LIMIT2 = 20;
var REQUEST_TIMEOUT_MS4 = 25000;
var DEFAULT_WINDOW_DAYS = 60;
var RECENT_COUNT_WINDOW_DAYS = 90;
var BIORXIV_CATEGORIES = [
  "animal behavior and cognition",
  "biochemistry",
  "bioengineering",
  "bioinformatics",
  "biophysics",
  "cancer biology",
  "cell biology",
  "clinical trials",
  "developmental biology",
  "ecology",
  "epidemiology",
  "evolutionary biology",
  "genetics",
  "genomics",
  "immunology",
  "microbiology",
  "molecular biology",
  "neuroscience",
  "paleontology",
  "pathology",
  "pharmacology and toxicology",
  "physiology",
  "plant biology",
  "scientific communication and education",
  "synthetic biology",
  "systems biology",
  "zoology"
];
function recordValue4(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function arrayValue3(value) {
  return Array.isArray(value) ? value : [];
}
function stringValue4(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function numberValue3(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return;
}
function cleanQuery3(query) {
  const clean = query.trim();
  if (!clean)
    throw new Error("Science database search requires a non-empty query.");
  return clean;
}
function safeLimit2(value) {
  if (!Number.isFinite(value) || value === undefined)
    return DEFAULT_LIMIT2;
  return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT2));
}
function doiUrl2(doi) {
  return doi ? `https://doi.org/${doi}` : undefined;
}
function preprintDocs() {
  return [
    "https://api.biorxiv.org/",
    "https://api.biorxiv.org/pubs/help",
    "https://api.biorxiv.org/funder/help"
  ];
}
function preprintEndpoint(path) {
  return new URL(`${PREPRINT_API_BASE}${path}`);
}
async function fetchJson4(url) {
  const controller = new AbortController;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS4);
  try {
    const response = await researchFetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "feynman-science-database-search/1.0 (https://github.com/Companion-Inc/feynman)"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Preprint database request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}
function normalizePreprintDoi(query) {
  const clean = query.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  return /^10\.\d{4,9}\/\S+$/i.test(clean) ? clean : undefined;
}
function isDate(value) {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function recentDateRange(days) {
  const endDate = new Date;
  const startDate = new Date(endDate);
  startDate.setUTCDate(endDate.getUTCDate() - days);
  return {
    end: endDate.toISOString().slice(0, 10),
    start: startDate.toISOString().slice(0, 10)
  };
}
function optionValue(query, key) {
  const pattern = new RegExp(`(?:^|[\\s;])${key}=("[^"]+"|'[^']+'|[^\\s;]+)`, "i");
  const match = pattern.exec(query);
  const raw = match?.[1]?.trim();
  if (!raw)
    return;
  return raw.replace(/^["']|["']$/g, "");
}
function parseNumberOption(query, key) {
  const raw = optionValue(query, key);
  if (!raw)
    return;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}
function parseDateWindow(query) {
  const explicitFrom = optionValue(query, "date_from") ?? optionValue(query, "from");
  const explicitTo = optionValue(query, "date_to") ?? optionValue(query, "to");
  if (isDate(explicitFrom) && isDate(explicitTo)) {
    return { dateFrom: explicitFrom, dateTo: explicitTo };
  }
  const range = /(\d{4}-\d{2}-\d{2})\s*(?:\.\.|\/|:)\s*(\d{4}-\d{2}-\d{2})/.exec(query);
  if (range)
    return { dateFrom: range[1], dateTo: range[2] };
  return {};
}
function parseQueryOptions(query) {
  const { dateFrom, dateTo } = parseDateWindow(query);
  const intervalRaw = (optionValue(query, "interval") ?? "").toLowerCase();
  const category = optionValue(query, "category");
  const searchText = query.replace(/\b(?:date_from|date_to|from|to|category|cursor|recent_days|recent_count|interval|through|publisher|funder|ror)=("[^"]+"|'[^']+'|[^\s;]+)/gi, "").replace(/\d{4}-\d{2}-\d{2}\s*(?:\.\.|\/|:)\s*\d{4}-\d{2}-\d{2}/g, "").replace(/^(?:published|pubs|funder|ror|content-stats|content statistics|stats:content|usage-stats|usage statistics|stats:usage|categories)\s*:?\s*/i, "").trim();
  return {
    category,
    cursor: parseNumberOption(query, "cursor") ?? 0,
    dateFrom,
    dateTo,
    funderRorId: optionValue(query, "funder") ?? optionValue(query, "ror"),
    interval: intervalRaw === "yearly" || intervalRaw === "y" ? "y" : "m",
    publisher: optionValue(query, "publisher"),
    recentCount: parseNumberOption(query, "recent_count"),
    recentDays: parseNumberOption(query, "recent_days"),
    searchText,
    through: optionValue(query, "through")
  };
}
function resolveWindow(options) {
  if (options.dateFrom && options.dateTo)
    return { dateFrom: options.dateFrom, dateTo: options.dateTo };
  if (options.recentDays !== undefined) {
    const range2 = recentDateRange(options.recentDays);
    return { dateFrom: range2.start, dateTo: range2.end };
  }
  if (options.recentCount !== undefined) {
    const range2 = recentDateRange(RECENT_COUNT_WINDOW_DAYS);
    return { dateFrom: range2.start, dateTo: range2.end, recentCount: options.recentCount };
  }
  const range = recentDateRange(DEFAULT_WINDOW_DAYS);
  return { dateFrom: range.start, dateTo: range.end };
}
function messageValue(payload) {
  const messages = payload.messages;
  if (Array.isArray(messages))
    return recordValue4(messages[0]);
  return recordValue4(messages);
}
function totalFromMessage(message, fallback) {
  return numberValue3(message.total) ?? numberValue3(message.count) ?? fallback;
}
function categorySuffix(category) {
  return category ? `?category=${encodeURIComponent(category.trim().toLowerCase().replace(/\s+/g, "_"))}` : "";
}
function preprintUrl(server, doi, options) {
  if (doi)
    return preprintEndpoint(`/details/${server}/${doi}/na/json`);
  const range = resolveWindow(options);
  return preprintEndpoint(`/details/${server}/${range.dateFrom}/${range.dateTo}/${options.cursor}/json${categorySuffix(options.category)}`);
}
function preprintHost(server) {
  return server === "medrxiv" ? "www.medrxiv.org" : "www.biorxiv.org";
}
function normalizePreprintRecord(item, server) {
  const record = recordValue4(item);
  const doi = stringValue4(record.doi);
  const version = stringValue4(record.version);
  if (!doi)
    return;
  return {
    doi,
    title: stringValue4(record.title),
    authors: stringValue4(record.authors),
    correspondingAuthor: stringValue4(record.author_corresponding),
    correspondingInstitution: stringValue4(record.author_corresponding_institution),
    date: stringValue4(record.date),
    version,
    type: stringValue4(record.type),
    license: stringValue4(record.license),
    category: stringValue4(record.category),
    abstract: stringValue4(record.abstract),
    funding: arrayValue3(record.funding),
    jatsXmlPath: stringValue4(record["jats xml path"]),
    published: stringValue4(record.published),
    server: stringValue4(record.server) ?? server,
    url: `https://${preprintHost(server)}/content/${doi}${version ? `v${version}` : ""}`,
    doiUrl: doiUrl2(doi)
  };
}
function normalizePublishedRecord(item) {
  const record = recordValue4(item);
  const biorxivDoi = stringValue4(record.biorxiv_doi);
  const publishedDoi = stringValue4(record.published_doi);
  return {
    preprintDoi: biorxivDoi,
    publishedDoi,
    publishedJournal: stringValue4(record.published_journal),
    preprintPlatform: stringValue4(record.preprint_platform),
    preprintTitle: stringValue4(record.preprint_title),
    preprintAuthors: stringValue4(record.preprint_authors),
    preprintCategory: stringValue4(record.preprint_category),
    preprintDate: stringValue4(record.preprint_date),
    publishedDate: stringValue4(record.published_date),
    preprintAbstract: stringValue4(record.preprint_abstract),
    correspondingAuthor: stringValue4(record.preprint_author_corresponding),
    correspondingInstitution: stringValue4(record.preprint_author_corresponding_institution),
    preprintDoiUrl: doiUrl2(biorxivDoi),
    publishedDoiUrl: doiUrl2(publishedDoi)
  };
}
function filterBySearchText(records, searchText, doiMode) {
  if (doiMode || !searchText)
    return records;
  const queryLower = searchText.toLowerCase();
  return records.filter((record) => [record.title, record.abstract, record.authors, record.category, record.doi].some((value) => String(value ?? "").toLowerCase().includes(queryLower)));
}
async function fetchPreprintCollection(server, doi, options) {
  let url = preprintUrl(server, doi, options);
  if (!doi && options.recentCount !== undefined) {
    const range = resolveWindow(options);
    const firstUrl = preprintEndpoint(`/details/${server}/${range.dateFrom}/${range.dateTo}/0/json${categorySuffix(options.category)}`);
    const firstPayload = recordValue4(await fetchJson4(firstUrl));
    const firstCollection = arrayValue3(firstPayload.collection);
    const total = totalFromMessage(messageValue(firstPayload), firstCollection.length);
    const cursor = Math.max(total - options.recentCount, 0) + options.cursor;
    url = preprintEndpoint(`/details/${server}/${range.dateFrom}/${range.dateTo}/${cursor}/json${categorySuffix(options.category)}`);
  }
  const payload = recordValue4(await fetchJson4(url));
  const collection = arrayValue3(payload.collection);
  return {
    collection,
    endpoint: url.toString(),
    total: totalFromMessage(messageValue(payload), collection.length)
  };
}
function normalizeRorId(query, options) {
  const source = (options.funderRorId ?? options.searchText ?? query).trim();
  const raw = (source.split("/").pop() ?? source).toLowerCase();
  const clean = raw.replace(/^funder:\s*/i, "").replace(/^ror:\s*/i, "");
  if (!/^[0-9a-z]{9}$/.test(clean)) {
    throw new Error(`Funder lookup requires a 9-character ROR ID, got ${raw || query}.`);
  }
  return clean;
}
async function searchFunderPreprints(params, server, query, options) {
  const limit = safeLimit2(params.limit);
  const range = resolveWindow(options);
  const rorId = normalizeRorId(query, options);
  const url = preprintEndpoint(`/funder/${server}/${range.dateFrom}/${range.dateTo}/${rorId}/${options.cursor}/json${categorySuffix(options.category)}`);
  const payload = recordValue4(await fetchJson4(url));
  const collection = arrayValue3(payload.collection);
  const results = collection.flatMap((item) => {
    const normalized = normalizePreprintRecord(item, server);
    return normalized ? [normalized] : [];
  }).slice(0, limit);
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: server,
    query,
    searchMode: "funder-ror",
    rorId,
    cursor: options.cursor,
    totalCount: totalFromMessage(messageValue(payload), collection.length),
    returned: results.length,
    results,
    provenance: {
      docs: preprintDocs(),
      endpoints: [url.toString()]
    }
  };
}
async function searchPublishedPreprints(params, server, query, options) {
  const limit = safeLimit2(params.limit);
  const range = resolveWindow(options);
  let url;
  if (options.publisher) {
    if (server !== "biorxiv")
      throw new Error("Publisher-prefix published-preprint lookup is bioRxiv-only.");
    if (!/^10\.\d{4,9}$/.test(options.publisher))
      throw new Error(`Publisher prefix must look like 10.1038, got ${options.publisher}.`);
    url = preprintEndpoint(`/publisher/${options.publisher}/${range.dateFrom}/${range.dateTo}/${options.cursor}`);
  } else {
    url = preprintEndpoint(`/pubs/${server}/${range.dateFrom}/${range.dateTo}/${options.cursor}/json`);
  }
  const payload = recordValue4(await fetchJson4(url));
  const collection = arrayValue3(payload.collection);
  const results = collection.map(normalizePublishedRecord).slice(0, limit);
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: server,
    query,
    searchMode: "published-preprints",
    cursor: options.cursor,
    totalCount: totalFromMessage(messageValue(payload), collection.length),
    returned: results.length,
    results,
    provenance: {
      docs: preprintDocs(),
      endpoints: [url.toString()]
    }
  };
}
function keepStatsRow(row, through) {
  if (!through)
    return true;
  const month = stringValue4(row.month);
  if (month)
    return month.slice(0, 7) <= through.slice(0, 7);
  const year = numberValue3(row.year);
  const throughYear = Number(through.slice(0, 4));
  return year === undefined || !Number.isFinite(throughYear) || year <= throughYear;
}
async function preprintStats(server, query, options, mode) {
  if (mode === "content-statistics" && server !== "biorxiv") {
    throw new Error("bioRxiv content summary statistics are available from source=biorxiv; use usage-stats for server-specific bioRxiv/medRxiv usage statistics.");
  }
  const endpointPath3 = mode === "content-statistics" ? `/sum/${options.interval}/json` : `/usage/${options.interval}/${server}/json`;
  const url = preprintEndpoint(endpointPath3);
  const payload = recordValue4(await fetchJson4(url));
  const rowsKey = Object.keys(payload).find((key) => key !== "messages");
  const rows = arrayValue3(rowsKey ? payload[rowsKey] : []).map(recordValue4).filter((row) => keepStatsRow(row, options.through));
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: server,
    query,
    searchMode: mode,
    interval: options.interval === "y" ? "yearly" : "monthly",
    through: options.through,
    returned: rows.length,
    results: rows,
    provenance: {
      docs: preprintDocs(),
      endpoints: [url.toString()]
    }
  };
}
async function searchPreprints(params, server) {
  const query = cleanQuery3(params.query);
  const options = parseQueryOptions(query);
  if (/^categories$/i.test(query)) {
    return {
      schema: "feynman.scienceDatabaseSearch.v1",
      source: server,
      query,
      searchMode: "categories",
      returned: BIORXIV_CATEGORIES.length,
      results: [...BIORXIV_CATEGORIES],
      provenance: {
        docs: preprintDocs(),
        note: "bioRxiv subject category list mirrored as Feynman-owned connector metadata."
      }
    };
  }
  if (/^(content-stats|content statistics|stats:content)\b/i.test(query)) {
    return preprintStats(server, query, options, "content-statistics");
  }
  if (/^(usage-stats|usage statistics|stats:usage)\b/i.test(query)) {
    return preprintStats(server, query, options, "usage-statistics");
  }
  if (/^(published|pubs)\b/i.test(query) || options.publisher) {
    return searchPublishedPreprints(params, server, query, options);
  }
  if (/^(funder|ror)\b/i.test(query) || options.funderRorId) {
    return searchFunderPreprints(params, server, query, options);
  }
  const limit = safeLimit2(params.limit);
  const doi = normalizePreprintDoi(query);
  const fetched = await fetchPreprintCollection(server, doi, options);
  const normalized = fetched.collection.flatMap((item) => {
    const record = normalizePreprintRecord(item, server);
    return record ? [record] : [];
  });
  const results = filterBySearchText(normalized, options.searchText, Boolean(doi)).slice(0, limit);
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: server,
    query,
    searchMode: doi ? "doi" : "recent-60-day-filter",
    cursor: options.cursor,
    totalCount: fetched.total,
    returned: results.length,
    results,
    provenance: {
      docs: preprintDocs(),
      endpoints: [fetched.endpoint]
    }
  };
}

// vendor/upstream/science-database-pubmed-parsers.ts
import { XMLParser as XMLParser2 } from "fast-xml-parser";
var SECTION_TEXT_SNIPPET_CHARS = 1200;
var MAX_SECTIONS_RETURNED = 10;
var xmlParser2 = new XMLParser2({
  ignoreAttributes: false,
  removeNSPrefix: true
});
var orderedTextParser = new XMLParser2({
  preserveOrder: true,
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false
});
function recordValue5(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function listValue(value) {
  if (value === undefined || value === null)
    return [];
  return Array.isArray(value) ? value : [value];
}
function stringValue5(value) {
  if (typeof value === "string" && value.trim())
    return value.trim();
  if (typeof value === "number" && Number.isFinite(value))
    return String(value);
  return;
}
function numberValue4(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return;
}
function prune(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
function textValue(value) {
  if (typeof value === "string" || typeof value === "number")
    return stringValue5(value);
  if (Array.isArray(value)) {
    const parts2 = value.map((item) => textValue(item)).filter((item) => Boolean(item));
    return parts2.length ? parts2.join(" ").replace(/\s+/g, " ").trim() : undefined;
  }
  const record = recordValue5(value);
  const direct = stringValue5(record["#text"]);
  if (direct)
    return direct;
  const parts = Object.entries(record).filter(([key]) => !key.startsWith("@_")).map(([, item]) => textValue(item)).filter((item) => Boolean(item));
  return parts.length ? parts.join(" ").replace(/\s+/g, " ").trim() : undefined;
}
function orderedChildren(value, tag) {
  return listValue(value).flatMap((node) => {
    const children = recordValue5(node)[tag];
    return children === undefined ? [] : [children];
  });
}
function orderedText(value) {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return value.map((node) => orderedText(node)).join("");
  return Object.entries(recordValue5(value)).filter(([key]) => key !== ":@" && !key.startsWith("?")).map(([, children]) => orderedText(children)).join("");
}
function orderedTextValue(value) {
  return orderedText(value).replace(/\s+/g, " ").trim() || undefined;
}
function orderedPubmedArticles(xml) {
  const set = orderedChildren(orderedTextParser.parse(xml), "PubmedArticleSet")[0];
  return orderedChildren(set, "PubmedArticle");
}
function dateObject(value) {
  const record = recordValue5(value);
  const monthMap = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12"
  };
  const year = textValue(record.Year);
  const monthRaw = textValue(record.Month);
  const day = textValue(record.Day);
  const month = monthRaw ? monthMap[monthRaw] ?? (/^\d+$/.test(monthRaw) ? monthRaw.padStart(2, "0") : monthRaw) : undefined;
  const output = prune({
    year,
    month,
    day: day && /^\d+$/.test(day) ? day.padStart(2, "0") : day
  });
  return Object.keys(output).length ? output : undefined;
}
function parseArticleIds(article) {
  const identifiers = {};
  const citation = recordValue5(article.MedlineCitation);
  const pmid = textValue(citation.PMID);
  if (pmid)
    identifiers.pmid = pmid;
  const articleIds = recordValue5(recordValue5(article.PubmedData).ArticleIdList).ArticleId;
  for (const item of listValue(articleIds)) {
    const record = recordValue5(item);
    const idType = stringValue5(record["@_IdType"])?.toLowerCase();
    const value = textValue(item);
    if (!idType || !value)
      continue;
    if (idType === "pubmed")
      identifiers.pmid = value;
    else if (idType === "pmc")
      identifiers.pmc = value;
    else if (idType === "doi")
      identifiers.doi = value;
    else if (idType === "pii")
      identifiers.pii = value;
  }
  return identifiers;
}
function parseAuthors(value) {
  return listValue(value).map((item) => {
    const author = recordValue5(item);
    const collective = textValue(author.CollectiveName);
    const affiliations = listValue(author.AffiliationInfo).flatMap((info) => listValue(recordValue5(info).Affiliation)).map((affiliation) => textValue(affiliation)).filter((affiliation) => Boolean(affiliation));
    if (collective)
      return { collectiveName: collective, affiliations };
    return prune({
      lastName: textValue(author.LastName),
      foreName: textValue(author.ForeName),
      initials: textValue(author.Initials),
      affiliations
    });
  });
}
function parsePubmedArticle(value, orderedArticle) {
  const articleRoot = recordValue5(value);
  const citation = recordValue5(articleRoot.MedlineCitation);
  const article = recordValue5(citation.Article);
  const journal = recordValue5(article.Journal);
  const issue = recordValue5(journal.JournalIssue);
  const orderedCitation = orderedChildren(orderedArticle, "MedlineCitation")[0];
  const orderedContent = orderedChildren(orderedCitation, "Article")[0];
  const orderedAbstract = orderedChildren(orderedContent, "Abstract")[0];
  const abstractParts = orderedChildren(orderedAbstract, "AbstractText").map((part) => orderedTextValue(part)).filter((part) => Boolean(part));
  const publicationTypes = listValue(recordValue5(article.PublicationTypeList).PublicationType).map((item) => textValue(item)).filter((item) => Boolean(item));
  const meshTerms = listValue(recordValue5(citation.MeshHeadingList).MeshHeading).map((heading) => textValue(recordValue5(heading).DescriptorName)).filter((term) => Boolean(term));
  const identifiers = parseArticleIds(articleRoot);
  const citationRecord = prune({
    volume: textValue(issue.Volume),
    issue: textValue(issue.Issue),
    pages: textValue(recordValue5(article.Pagination).MedlinePgn)
  });
  return prune({
    identifiers,
    pmid: identifiers.pmid,
    pmcid: identifiers.pmc,
    doi: identifiers.doi,
    title: orderedTextValue(orderedChildren(orderedContent, "ArticleTitle")[0]),
    abstract: abstractParts.length ? abstractParts.join(`
`) : undefined,
    journal: prune({
      title: textValue(journal.Title),
      isoAbbreviation: textValue(journal.ISOAbbreviation)
    }),
    authors: parseAuthors(recordValue5(article.AuthorList).Author),
    publicationDate: dateObject(issue.PubDate) ?? dateObject(article.ArticleDate),
    meshTerms,
    articleTypes: publicationTypes,
    language: textValue(article.Language),
    citation: citationRecord,
    url: identifiers.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${identifiers.pmid}/` : undefined,
    doiUrl: identifiers.doi ? `https://doi.org/${identifiers.doi}` : undefined
  });
}
function parsePubmedArticles(xml) {
  const parsed = recordValue5(xmlParser2.parse(xml));
  const set = recordValue5(parsed.PubmedArticleSet);
  const orderedArticles = orderedPubmedArticles(xml);
  return listValue(set.PubmedArticle).map((article, index) => parsePubmedArticle(article, orderedArticles[index]));
}
function jatsArticleId(meta, type) {
  for (const item of listValue(meta["article-id"])) {
    const record = recordValue5(item);
    if (stringValue5(record["@_pub-id-type"])?.toLowerCase() === type)
      return textValue(item);
  }
  return;
}
function truncateText(value, limit) {
  if (!value)
    return;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit).trimEnd()}...` : clean;
}
function sectionText(section) {
  const record = recordValue5(section);
  const title = textValue(record.title);
  const bodyParts = Object.entries(record).filter(([key]) => !key.startsWith("@_") && !["title", "fig", "table-wrap", "sec"].includes(key)).map(([, value]) => textValue(value)).filter((value) => Boolean(value));
  return [title, ...bodyParts].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
function parseFullTextXml(xml, pmcid, fallback = {}) {
  const parsed = recordValue5(xmlParser2.parse(xml));
  const article = recordValue5(parsed.article);
  const meta = recordValue5(recordValue5(article.front)["article-meta"]);
  const body = recordValue5(article.body);
  const sections = listValue(body.sec).map((section, index) => {
    const record = recordValue5(section);
    const title = textValue(record.title) ?? `Section ${index + 1}`;
    return {
      index: index + 1,
      title,
      textSnippet: truncateText(sectionText(section), SECTION_TEXT_SNIPPET_CHARS)
    };
  }).filter((section) => section.textSnippet).slice(0, MAX_SECTIONS_RETURNED);
  const permissions = recordValue5(meta.permissions);
  const license = recordValue5(permissions.license);
  const licenseType = stringValue5(license["@_license-type"]);
  const licenseUrl = stringValue5(license["@_href"]);
  return prune({
    inputId: pmcid,
    pmcid,
    pmid: jatsArticleId(meta, "pmid") ?? stringValue5(fallback.pmid),
    doi: jatsArticleId(meta, "doi") ?? stringValue5(fallback.doi),
    title: textValue(recordValue5(meta["title-group"])["article-title"]) ?? stringValue5(fallback.title),
    abstract: truncateText(textValue(recordValue5(meta.abstract).p), 2000) ?? stringValue5(fallback.abstractText),
    fullTextStatus: "retrieved",
    fullTextAvailable: true,
    sectionCount: sections.length,
    sections,
    license: prune({
      type: licenseType,
      url: licenseUrl,
      isOpenAccess: Boolean(licenseType || licenseUrl)
    }),
    copyright: prune({
      statement: textValue(permissions["copyright-statement"]),
      year: numberValue4(textValue(permissions["copyright-year"]))
    }),
    rawXmlBytes: Buffer.byteLength(xml, "utf8"),
    url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
    contentPolicy: "Returned section snippets are bounded; raw fullTextXML is not included in tool output."
  });
}
function copyrightFromPubmedXml(xml) {
  const map = new Map;
  const parsed = recordValue5(xmlParser2.parse(xml));
  const set = recordValue5(parsed.PubmedArticleSet);
  const orderedArticles = orderedPubmedArticles(xml);
  for (const [index, rawArticle] of listValue(set.PubmedArticle).entries()) {
    const article = parsePubmedArticle(rawArticle, orderedArticles[index]);
    const pmid = stringValue5(article.pmid);
    if (!pmid)
      continue;
    const pubmedArticle = recordValue5(rawArticle);
    const copyright = textValue(recordValue5(recordValue5(recordValue5(pubmedArticle.MedlineCitation).Article).Abstract).CopyrightInformation);
    map.set(pmid, { article, copyright });
  }
  return map;
}

// vendor/upstream/ncbi-rate-limit.ts
var ANONYMOUS_MIN_GAP_MS = 500;
var API_KEY_MIN_GAP_MS = 125;
var NCBI_HOSTS = new Set(["eutils.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov"]);
var chain = Promise.resolve();
var lastStartedAt = Number.NEGATIVE_INFINITY;
function minGapMs(url) {
  const override = Number(process.env.NCBI_MIN_REQUEST_GAP_MS);
  if (Number.isFinite(override) && override >= 0)
    return override;
  return url.searchParams.has("api_key") ? API_KEY_MIN_GAP_MS : ANONYMOUS_MIN_GAP_MS;
}
function withNcbiRateLimit(url, start) {
  if (!NCBI_HOSTS.has(url.hostname))
    return start();
  const slot = chain.then(async () => {
    const wait = lastStartedAt + minGapMs(url) - performance.now();
    if (wait > 0)
      await new Promise((resolve) => setTimeout(resolve, wait));
    lastStartedAt = performance.now();
  });
  chain = slot;
  return slot.then(start);
}

// vendor/upstream/science-database-pubmed.ts
var NCBI_EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
var PMC_IDCONV_URL = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/";
var NCBI_EUTILS_DOCS = "https://www.ncbi.nlm.nih.gov/books/NBK25499/";
var PMC_IDCONV_DOCS = "https://pmc.ncbi.nlm.nih.gov/tools/id-converter-api/";
var EUROPE_PMC_DOCS = "https://europepmc.org/RestfulWebService";
var EUROPE_PMC_REST_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
var DEFAULT_LIMIT3 = 5;
var MAX_LIMIT3 = 20;
var REQUEST_TIMEOUT_MS5 = 25000;
var requestTimeoutMs = REQUEST_TIMEOUT_MS5;
function recordValue6(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function listValue2(value) {
  if (value === undefined || value === null)
    return [];
  return Array.isArray(value) ? value : [value];
}
function stringValue6(value) {
  if (typeof value === "string" && value.trim())
    return value.trim();
  if (typeof value === "number" && Number.isFinite(value))
    return String(value);
  return;
}
function numberValue5(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return;
}
function safeLimit3(value) {
  if (!Number.isFinite(value) || value === undefined)
    return DEFAULT_LIMIT3;
  return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT3));
}
function cleanQuery4(query) {
  const clean = query.trim();
  if (!clean)
    throw new Error("PubMed search requires a non-empty query.");
  return clean;
}
function ncbiIdentityParams() {
  const email = process.env.NCBI_EMAIL?.trim();
  const apiKey = process.env.NCBI_API_KEY?.trim();
  return {
    tool: "feynman",
    ...email ? { email } : {},
    ...apiKey ? { api_key: apiKey } : {}
  };
}
function pmcIdentityParams() {
  const email = process.env.NCBI_EMAIL?.trim();
  return {
    tool: "feynman",
    ...email ? { email } : {}
  };
}
function scrubEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.searchParams.has("api_key"))
    url.searchParams.set("api_key", "[redacted]");
  return url.toString();
}
function prune2(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
var NCBI_RETRY_MS = 1500;
async function send(url, accept, read) {
  for (let attempt = 0;; attempt += 1) {
    const result = await withNcbiRateLimit(url, async () => {
      const controller = new AbortController;
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await researchFetch(url, {
          headers: {
            accept,
            "user-agent": "feynman-pubmed-tools/1.0 (https://github.com/Companion-Inc/feynman)"
          },
          signal: controller.signal
        });
        if (response.status === 429 && attempt === 0)
          return { retry: true };
        return { value: await read(response) };
      } finally {
        clearTimeout(timeout);
      }
    });
    if ("value" in result)
      return result.value;
    await new Promise((resolve) => setTimeout(resolve, NCBI_RETRY_MS));
  }
}
function assertOk(response) {
  if (!response.ok)
    throw new Error(`PubMed request failed: ${response.status} ${response.statusText}`);
}
async function fetchJson5(url) {
  return send(url, "application/json", async (response) => {
    assertOk(response);
    return recordValue6(await response.json());
  });
}
async function fetchText2(url, accept = "application/xml,text/xml,text/plain,*/*") {
  return send(url, accept, async (response) => {
    assertOk(response);
    return response.text();
  });
}
async function fetchOptionalText(url, accept = "application/xml,text/xml,*/*") {
  return send(url, accept, async (response) => {
    if (response.status === 404)
      return { status: 404 };
    assertOk(response);
    return { status: response.status, text: await response.text() };
  });
}
function queryOptions(query) {
  const options = {};
  const pattern = /(?:^|\s)([a-zA-Z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|([^\s;]+))/g;
  for (const match of query.matchAll(pattern)) {
    options[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return options;
}
function removeOptions(query) {
  return query.replace(/(?:^|\s)[a-zA-Z_][\w-]*=(?:"[^"]*"|'[^']*'|[^\s;]+)/g, " ").replace(/\s+/g, " ").trim();
}
function stripMode(query, modes) {
  const clean = query.trim();
  for (const mode of modes) {
    const pattern = new RegExp(`^${mode}(?::|\\s+)\\s*`, "i");
    if (pattern.test(clean))
      return clean.replace(pattern, "").trim();
  }
  return clean;
}
function splitIds(value) {
  if (!value)
    return [];
  return value.split(/[\s,;]+/).map((id) => id.trim()).filter(Boolean);
}
function parseIdList(query, modes, optionKeys = ["ids", "pmids", "pmcids"]) {
  const body = stripMode(query, modes);
  const options = queryOptions(body);
  const ids = optionKeys.flatMap((key) => splitIds(options[key]));
  const rest = splitIds(removeOptions(body));
  const combined = [...ids, ...rest];
  const seen = new Set;
  return combined.filter((id) => {
    const key = id.toLowerCase();
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}
function normalizePmcid(value) {
  const clean = value.trim().replace(/^pmcid\s*:/i, "");
  if (/^\d+$/.test(clean))
    return `PMC${clean}`;
  if (/^PMC\d+$/i.test(clean))
    return clean.toUpperCase();
  return clean.toUpperCase();
}
function parseMode(query) {
  const clean = query.trim();
  if (/^(?:convert|ids?)(?::|\s+)/i.test(clean))
    return "id-conversion";
  if (/^(?:metadata|article|get|pmid)(?::|\s+)/i.test(clean))
    return "metadata";
  if (/^\d+(?:[\s,;]+\d+)*$/.test(clean))
    return "metadata";
  if (/^(?:related|links?)(?::|\s+)/i.test(clean))
    return "related";
  if (/^(?:fulltext|full-text|pmc)(?::|\s+)/i.test(clean) || /^PMC\d+$/i.test(clean))
    return "fulltext";
  if (/^(?:copyright|license)(?::|\s+)/i.test(clean))
    return "copyright";
  if (/^(?:citation|citmatch)(?::|\s+)/i.test(clean))
    return "citation-lookup";
  return "search";
}
function articleId(doc, idType) {
  for (const item of listValue2(doc.articleids)) {
    const record = recordValue6(item);
    if (stringValue6(record.idtype)?.toLowerCase() === idType)
      return stringValue6(record.value);
  }
  return;
}
function authorNames(value) {
  return listValue2(value).map((author) => stringValue6(recordValue6(author).name)).filter((name) => Boolean(name)).slice(0, 8);
}
async function searchArticles(params, rawQuery) {
  const query = cleanQuery4(rawQuery ?? params.query);
  const options = queryOptions(query);
  const searchTerm = removeOptions(stripMode(query, ["search"])) || query;
  const limit = safeLimit3(params.limit ?? numberValue5(options.max_results) ?? numberValue5(options.max));
  const retstart = Math.max(0, Math.floor(numberValue5(options.retstart) ?? 0));
  const searchUrl = new URL(`${NCBI_EUTILS_BASE}/esearch.fcgi`);
  searchUrl.search = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    retmax: String(limit),
    retstart: String(retstart),
    sort: options.sort ?? params.sort ?? "relevance",
    term: searchTerm,
    ...options.date_from || options.date_to ? { datetype: options.datetype ?? "pdat" } : {},
    ...options.date_from ? { mindate: options.date_from } : {},
    ...options.date_to ? { maxdate: options.date_to } : {},
    ...ncbiIdentityParams()
  }).toString();
  const search = await fetchJson5(searchUrl);
  const esearch = recordValue6(search.esearchresult);
  const ids = listValue2(esearch.idlist).map((id) => stringValue6(id)).filter((id) => Boolean(id));
  const endpoints = [scrubEndpoint(searchUrl.toString())];
  if (!ids.length) {
    return {
      schema: "feynman.scienceDatabaseSearch.v1",
      source: "pubmed",
      mode: "search",
      query: searchTerm,
      totalCount: numberValue5(esearch.count) ?? 0,
      returned: 0,
      queryTranslation: stringValue6(esearch.querytranslation),
      hasMore: false,
      results: [],
      provenance: { docs: NCBI_EUTILS_DOCS, endpoints }
    };
  }
  const summaryUrl = new URL(`${NCBI_EUTILS_BASE}/esummary.fcgi`);
  summaryUrl.search = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "json",
    ...ncbiIdentityParams()
  }).toString();
  endpoints.push(scrubEndpoint(summaryUrl.toString()));
  const summary = await fetchJson5(summaryUrl);
  const result = recordValue6(summary.result);
  const results = ids.flatMap((id) => {
    const doc = recordValue6(result[id]);
    if (!Object.keys(doc).length)
      return [];
    const doi = articleId(doc, "doi");
    return [prune2({
      pmid: id,
      title: stringValue6(doc.title),
      journal: stringValue6(doc.fulljournalname) ?? stringValue6(doc.source),
      publicationDate: stringValue6(doc.pubdate) ?? stringValue6(doc.epubdate),
      authors: authorNames(doc.authors),
      doi,
      publicationTypes: listValue2(doc.pubtype).map((item) => stringValue6(item)).filter(Boolean),
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      doiUrl: doi ? `https://doi.org/${doi}` : undefined
    })];
  });
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "pubmed",
    mode: "search",
    query: searchTerm,
    totalCount: numberValue5(esearch.count) ?? results.length,
    returned: results.length,
    retstart,
    queryTranslation: stringValue6(esearch.querytranslation),
    hasMore: retstart + results.length < (numberValue5(esearch.count) ?? results.length),
    results,
    provenance: { docs: NCBI_EUTILS_DOCS, endpoints }
  };
}
async function fetchArticleMetadata(params) {
  const pmids = parseIdList(params.query, ["metadata", "article", "get", "pmid"], ["pmids", "ids"]);
  if (!pmids.length)
    throw new Error("PubMed metadata lookup requires at least one PMID.");
  const url = new URL(`${NCBI_EUTILS_BASE}/efetch.fcgi`);
  url.search = new URLSearchParams({
    db: "pubmed",
    id: pmids.slice(0, MAX_LIMIT3).join(","),
    retmode: "xml",
    ...ncbiIdentityParams()
  }).toString();
  const xml = await fetchText2(url);
  const results = parsePubmedArticles(xml);
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "pubmed",
    mode: "metadata",
    query: params.query,
    requestedPmids: pmids,
    returned: results.length,
    results,
    importantLegalNotice: "Cite PubMed and returned DOI links when using article metadata in answers.",
    provenance: { docs: NCBI_EUTILS_DOCS, endpoints: [scrubEndpoint(url.toString())] }
  };
}
async function convertArticleIds(params) {
  const options = queryOptions(params.query);
  const ids = parseIdList(params.query, ["convert", "id", "ids"], ["ids"]);
  if (!ids.length)
    throw new Error("PubMed ID conversion requires ids, for example convert:35486828 id_type=pmid.");
  const idType = (options.id_type ?? options.idtype ?? "pmid").toLowerCase();
  const url = new URL(PMC_IDCONV_URL);
  url.search = new URLSearchParams({
    ids: ids.slice(0, MAX_LIMIT3).join(","),
    format: "json",
    idtype: idType,
    ...pmcIdentityParams()
  }).toString();
  const payload = await fetchJson5(url);
  const records = listValue2(payload.records).map((item) => {
    const record = recordValue6(item);
    return prune2({
      requestedId: stringValue6(record["requested-id"]) ?? stringValue6(record.requested_id),
      pmid: stringValue6(record.pmid),
      pmcid: stringValue6(record.pmcid),
      doi: stringValue6(record.doi),
      status: stringValue6(record.status),
      error: stringValue6(record.errmsg),
      pubmedUrl: stringValue6(record.pmid) ? `https://pubmed.ncbi.nlm.nih.gov/${stringValue6(record.pmid)}/` : undefined,
      pmcUrl: stringValue6(record.pmcid) ? `https://pmc.ncbi.nlm.nih.gov/articles/${stringValue6(record.pmcid)}/` : undefined,
      doiUrl: stringValue6(record.doi) ? `https://doi.org/${stringValue6(record.doi)}` : undefined
    });
  });
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "pubmed",
    mode: "id-conversion",
    query: params.query,
    idType,
    returned: records.length,
    results: records,
    provenance: { docs: PMC_IDCONV_DOCS, endpoints: [scrubEndpoint(url.toString())] }
  };
}
async function relatedArticles(params) {
  const options = queryOptions(params.query);
  const pmids = parseIdList(params.query, ["related", "link", "links"], ["pmids", "ids"]);
  if (!pmids.length)
    throw new Error("PubMed related-article lookup requires at least one PMID.");
  const linkType = options.link_type ?? options.linkname ?? "pubmed_pubmed";
  const db = linkType.split("_")[1] || "pubmed";
  const maxResults = Math.max(1, Math.min(Math.floor(numberValue5(options.max_results) ?? numberValue5(options.max) ?? params.limit ?? DEFAULT_LIMIT3), MAX_LIMIT3));
  const url = new URL(`${NCBI_EUTILS_BASE}/elink.fcgi`);
  url.search = new URLSearchParams({
    dbfrom: "pubmed",
    db,
    id: pmids.slice(0, MAX_LIMIT3).join(","),
    retmode: "json",
    linkname: linkType,
    ...ncbiIdentityParams()
  }).toString();
  const payload = await fetchJson5(url);
  const linksets = listValue2(payload.linksets).map((item) => {
    const linkset = recordValue6(item);
    return {
      dbfrom: stringValue6(linkset.dbfrom),
      ids: listValue2(linkset.ids).map((id) => stringValue6(id)).filter(Boolean),
      linksetdbs: listValue2(linkset.linksetdbs).map((dbRecord) => {
        const record = recordValue6(dbRecord);
        return {
          dbto: stringValue6(record.dbto),
          linkname: stringValue6(record.linkname),
          links: listValue2(record.links).map((id) => stringValue6(id)).filter(Boolean).slice(0, maxResults)
        };
      })
    };
  });
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "pubmed",
    mode: "related",
    query: params.query,
    linkType,
    requestedPmids: pmids,
    linksets,
    returned: linksets.reduce((sum, linkset) => sum + linkset.linksetdbs.reduce((inner, dbRecord) => inner + dbRecord.links.length, 0), 0),
    provenance: { docs: NCBI_EUTILS_DOCS, endpoints: [scrubEndpoint(url.toString())] }
  };
}
async function fullTextArticles(params) {
  const ids = parseIdList(params.query, ["fulltext", "full-text", "pmc"], ["pmcids", "ids"]);
  if (!ids.length)
    throw new Error("PubMed full-text lookup requires a PMCID, for example fulltext:PMC5815332.");
  const endpoints = [];
  const results = [];
  for (const raw of ids.slice(0, Math.min(safeLimit3(params.limit), 5))) {
    const pmcid = normalizePmcid(raw);
    const availabilityUrl = new URL(`${EUROPE_PMC_REST_BASE}/search`);
    availabilityUrl.searchParams.set("query", `PMCID:${pmcid}`);
    availabilityUrl.searchParams.set("format", "json");
    availabilityUrl.searchParams.set("resultType", "core");
    availabilityUrl.searchParams.set("pageSize", "1");
    endpoints.push(availabilityUrl.toString());
    const availability = await fetchJson5(availabilityUrl);
    const hit = recordValue6(listValue2(recordValue6(availability.resultList).result)[0]);
    const resolvedPmcid = stringValue6(hit.pmcid)?.toUpperCase();
    if (resolvedPmcid !== pmcid) {
      results.push({
        inputId: raw,
        pmcid,
        found: false,
        fullTextAvailable: false,
        fullTextStatus: "not_found",
        detail: "PMCID did not resolve via Europe PMC."
      });
      continue;
    }
    if (String(hit.isOpenAccess ?? "").toUpperCase() !== "Y") {
      results.push(prune2({
        inputId: raw,
        pmcid,
        pmid: stringValue6(hit.pmid) ?? stringValue6(hit.id),
        doi: stringValue6(hit.doi),
        title: stringValue6(hit.title),
        found: true,
        fullTextAvailable: false,
        fullTextStatus: "not_open_access",
        url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`
      }));
      continue;
    }
    const fullTextUrl = new URL(`${EUROPE_PMC_REST_BASE}/${pmcid}/fullTextXML`);
    endpoints.push(fullTextUrl.toString());
    const fetched = await fetchOptionalText(fullTextUrl);
    if (!fetched.text) {
      results.push(prune2({
        inputId: raw,
        pmcid,
        pmid: stringValue6(hit.pmid) ?? stringValue6(hit.id),
        doi: stringValue6(hit.doi),
        title: stringValue6(hit.title),
        found: true,
        fullTextAvailable: false,
        fullTextStatus: fetched.status === 404 ? "xml_not_available" : "not_retrieved",
        url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`
      }));
      continue;
    }
    results.push(parseFullTextXml(fetched.text, pmcid, hit));
  }
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "pubmed",
    mode: "fulltext",
    query: params.query,
    delegatedSource: "Europe PMC open-access fullTextXML",
    returned: results.length,
    results,
    importantLegalNotice: "Cite PubMed/PMC and DOI links when using returned full-text section snippets.",
    provenance: { docs: [NCBI_EUTILS_DOCS, EUROPE_PMC_DOCS], endpoints }
  };
}
async function copyrightStatus(params) {
  const pmids = parseIdList(params.query, ["copyright", "license"], ["pmids", "ids"]);
  if (!pmids.length)
    throw new Error("PubMed copyright lookup requires at least one PMID.");
  const endpoints = [];
  const idconvUrl = new URL(PMC_IDCONV_URL);
  idconvUrl.search = new URLSearchParams({
    ids: pmids.slice(0, MAX_LIMIT3).join(","),
    format: "json",
    idtype: "pmid",
    ...pmcIdentityParams()
  }).toString();
  endpoints.push(scrubEndpoint(idconvUrl.toString()));
  const idconv = await fetchJson5(idconvUrl);
  const idMap = new Map;
  for (const item of listValue2(idconv.records)) {
    const record = recordValue6(item);
    const pmid = stringValue6(record.pmid) ?? stringValue6(record["requested-id"]);
    if (pmid)
      idMap.set(pmid, record);
  }
  const efetchUrl = new URL(`${NCBI_EUTILS_BASE}/efetch.fcgi`);
  efetchUrl.search = new URLSearchParams({
    db: "pubmed",
    id: pmids.slice(0, MAX_LIMIT3).join(","),
    retmode: "xml",
    ...ncbiIdentityParams()
  }).toString();
  endpoints.push(scrubEndpoint(efetchUrl.toString()));
  const pubmedXml = await fetchText2(efetchUrl);
  const pubmedCopyright = copyrightFromPubmedXml(pubmedXml);
  const results = [];
  for (const pmid of pmids.slice(0, MAX_LIMIT3)) {
    const mapped = idMap.get(pmid) ?? {};
    const pmcid = stringValue6(mapped.pmcid);
    const doi = stringValue6(mapped.doi);
    const pubmed = pubmedCopyright.get(pmid) ?? {};
    let pmcLicense;
    let pmcCopyright;
    if (pmcid) {
      const fullTextUrl = new URL(`${EUROPE_PMC_REST_BASE}/${pmcid.toUpperCase()}/fullTextXML`);
      endpoints.push(fullTextUrl.toString());
      const fetched = await fetchOptionalText(fullTextUrl);
      if (fetched.text) {
        const full = parseFullTextXml(fetched.text, pmcid.toUpperCase(), { pmid, doi });
        pmcLicense = recordValue6(full.license);
        pmcCopyright = recordValue6(full.copyright);
      }
    }
    const source = Object.keys(pmcLicense ?? {}).length ? "pmc" : stringValue6(pubmed.copyright) ? "pubmed" : "not_available";
    const isOpenAccess = Boolean(recordValue6(pmcLicense).isOpenAccess);
    results.push(prune2({
      pmid,
      pmcid,
      doi,
      copyright: prune2({
        statement: stringValue6(pmcCopyright?.statement) ?? stringValue6(pubmed.copyright),
        year: numberValue5(pmcCopyright?.year)
      }),
      license: prune2({
        type: stringValue6(pmcLicense?.type),
        url: stringValue6(pmcLicense?.url),
        isOpenAccess
      }),
      source,
      checkedSources: ["pubmed", ...pmcid ? ["pmc"] : []],
      availableAt: prune2({
        pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        pmcUrl: pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/` : undefined,
        doiUrl: doi ? `https://doi.org/${doi}` : undefined
      })
    }));
  }
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "pubmed",
    mode: "copyright",
    query: params.query,
    returned: results.length,
    results,
    summary: {
      totalChecked: results.length,
      foundInPubmed: results.filter((result) => result.source === "pubmed").length,
      foundInPmc: results.filter((result) => result.source === "pmc").length,
      notFound: results.filter((result) => result.source === "not_available").length,
      openAccessCount: results.filter((result) => recordValue6(result.license).isOpenAccess === true).length
    },
    provenance: { docs: [NCBI_EUTILS_DOCS, PMC_IDCONV_DOCS, EUROPE_PMC_DOCS], endpoints }
  };
}
function parseCitationInputs(query) {
  const body = stripMode(query, ["citation", "citmatch"]);
  const chunks = body.split(/\s*;\s*/).map((chunk) => chunk.trim()).filter(Boolean);
  const citations = chunks.map((chunk, index) => {
    const options = queryOptions(chunk);
    return prune2({
      journal: options.journal,
      year: options.year,
      volume: options.volume,
      first_page: options.first_page ?? options.page,
      author: options.author,
      key: options.key ?? `citation-${index + 1}`
    });
  });
  return citations.filter((citation) => citation.journal || citation.year || citation.first_page || citation.author);
}
function citationLine(citation) {
  return [
    citation.journal ?? "",
    citation.year ?? "",
    citation.volume ?? "",
    citation.first_page ?? "",
    citation.author ?? "",
    citation.key ?? "",
    ""
  ].join("|");
}
async function citationLookup(params) {
  const citations = parseCitationInputs(params.query);
  if (!citations.length) {
    throw new Error("PubMed citation lookup requires fields like citation journal=Nature year=2020 volume=580 first_page=123 author=Smith.");
  }
  const url = new URL(`${NCBI_EUTILS_BASE}/ecitmatch.cgi`);
  url.search = new URLSearchParams({
    db: "pubmed",
    retmode: "text",
    bdata: citations.slice(0, MAX_LIMIT3).map(citationLine).join(`
`),
    ...ncbiIdentityParams()
  }).toString();
  const text = await fetchText2(url, "text/plain,*/*");
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const results = citations.map((citation, index) => {
    const parts = (lines[index] ?? "").split("|");
    const pmid = parts[6]?.trim() || undefined;
    return prune2({
      ...citation,
      pmid,
      status: pmid ? "found" : "not_found",
      pubmedUrl: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : undefined
    });
  });
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "pubmed",
    mode: "citation-lookup",
    query: params.query,
    returned: results.length,
    results,
    provenance: { docs: NCBI_EUTILS_DOCS, endpoints: [scrubEndpoint(url.toString())] }
  };
}
async function searchPubMed(params) {
  const mode = parseMode(params.query);
  if (mode === "metadata")
    return fetchArticleMetadata(params);
  if (mode === "id-conversion")
    return convertArticleIds(params);
  if (mode === "related")
    return relatedArticles(params);
  if (mode === "fulltext")
    return fullTextArticles(params);
  if (mode === "copyright")
    return copyrightStatus(params);
  if (mode === "citation-lookup")
    return citationLookup(params);
  return searchArticles(params);
}

// vendor/upstream/science-database-europepmc-fulltext.ts
import { XMLParser as XMLParser3 } from "fast-xml-parser";
var DEFAULT_LIMIT4 = 2;
var MAX_LIMIT4 = 5;
var REQUEST_TIMEOUT_MS6 = 30000;
var DEADLINE_MS = 40000;
var EUROPE_PMC_REST_BASE2 = "https://www.ebi.ac.uk/europepmc/webservices/rest";
var EUROPE_PMC_DOCS2 = "https://europepmc.org/RestfulWebService";
var SECTION_TEXT_SNIPPET_CHARS2 = 1200;
var ABSTRACT_SNIPPET_CHARS = 2000;
var MAX_SECTIONS_RETURNED2 = 10;
var MAX_CAPTIONS_RETURNED = 8;
var RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
var xmlParser3 = new XMLParser3({
  ignoreAttributes: false,
  removeNSPrefix: true
});
function isEuropePmcFullTextQuery(query) {
  const clean = query.trim();
  if (/^(?:fulltext|full-text|jats|sections)(?::|\s+)/i.test(clean))
    return true;
  if (/^PMC\d+$/i.test(clean))
    return true;
  if (/^pmcid\s*:\s*(?:PMC)?\d+$/i.test(clean))
    return true;
  if (/^pmid\s*:\s*\d+$/i.test(clean))
    return true;
  return false;
}
function recordValue7(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function arrayValue4(value) {
  if (value === undefined || value === null)
    return [];
  return Array.isArray(value) ? value : [value];
}
function stringValue7(value) {
  if (typeof value === "string" && value.trim())
    return value.trim();
  if (typeof value === "number" && Number.isFinite(value))
    return String(value);
  return;
}
function numberValue6(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return;
}
function safeLimit4(value) {
  if (!Number.isFinite(value) || value === undefined)
    return DEFAULT_LIMIT4;
  return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT4));
}
function truncateText2(value, limit) {
  if (!value)
    return;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit).trimEnd()}...` : clean;
}
function stripPrefix(query) {
  return query.replace(/^(?:fulltext|full-text|jats|sections)(?::|\s+)\s*/i, "").trim();
}
function queryOptions2(query) {
  const options = {};
  for (const match of query.matchAll(/(?:^|\s)([a-zA-Z_][\w-]*)=([^\s]+)/g)) {
    options[match[1].toLowerCase()] = match[2];
  }
  return options;
}
function removeOptions2(query) {
  return query.replace(/(?:^|\s)[a-zA-Z_][\w-]*=[^\s]+/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeInputId(raw) {
  const trimmed = raw.trim();
  if (!trimmed)
    return;
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    if (/^(?:www\.)?ncbi\.nlm\.nih\.gov$/i.test(url.hostname) && parts[0] === "pmc" && parts[1] === "articles" && parts[2]) {
      return normalizeInputId(parts[2]);
    }
    if (/^pmc\.ncbi\.nlm\.nih\.gov$/i.test(url.hostname) && parts[0] === "articles" && parts[1]) {
      return normalizeInputId(parts[1]);
    }
    if (/^(?:www\.)?europepmc\.org$/i.test(url.hostname)) {
      if (parts[0] === "articles" && parts[1])
        return normalizeInputId(parts[1]);
      if (parts[0] === "article" && parts[2])
        return normalizeInputId(parts[2]);
    }
  } catch {}
  const clean = raw.trim().replace(/^pmcid\s*:\s*/i, "").replace(/^pmid\s*:\s*/i, "").replace(/^https?:\/\/(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc\/articles\//i, "").replace(/^https?:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\//i, "").replace(/^https?:\/\/europepmc\.org\/articles\//i, "").replace(/[/?#].*$/, "");
  if (/^PMC\d+$/i.test(clean))
    return { inputId: clean.toUpperCase(), type: "pmcid" };
  if (/^\d+$/.test(clean))
    return { inputId: clean, type: "pmid" };
  return { inputId: raw.trim(), type: "unknown" };
}
function parseInputIds(query, limit) {
  const raw = stripPrefix(query);
  const options = queryOptions2(raw);
  const tokens = [
    options.pmcid,
    options.pmid,
    ...removeOptions2(raw).split(/[\s,;]+/)
  ].filter((value) => Boolean(value));
  const ids = [];
  const seen = new Set;
  for (const token of tokens) {
    const normalized = normalizeInputId(token);
    if (!normalized)
      continue;
    const key = `${normalized.type}:${normalized.inputId}`;
    if (seen.has(key))
      continue;
    seen.add(key);
    ids.push(normalized);
    if (ids.length >= limit)
      break;
  }
  if (!ids.length)
    throw new Error("Europe PMC full-text lookup requires PMCID or PMID input, for example fulltext:PMC5815332.");
  return ids;
}
function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers.get("retry-after");
  const retrySeconds = retryAfter ? Number(retryAfter) : undefined;
  if (retrySeconds && Number.isFinite(retrySeconds))
    return Math.min(retrySeconds * 1000, 1e4);
  return Math.min(2 ** attempt * 1000, 1e4);
}
async function fetchWithRetry(url, init) {
  for (let attempt = 0;attempt <= 1; attempt += 1) {
    const controller = new AbortController;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS6);
    try {
      const response = await researchFetch(url, { ...init, signal: controller.signal });
      if (attempt < 1 && RETRY_STATUSES.has(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt + 1)));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= 1)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(undefined, attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("Europe PMC request failed before a response was available.");
}
async function fetchJson6(url) {
  const response = await fetchWithRetry(url, {
    headers: {
      accept: "application/json",
      "user-agent": "feynman-science-database-search/1.0 (https://github.com/Companion-Inc/feynman)"
    }
  });
  if (!response.ok)
    throw new Error(`Europe PMC request failed: ${response.status} ${response.statusText}`);
  return recordValue7(await response.json());
}
async function fetchText3(url) {
  const response = await fetchWithRetry(url, {
    headers: {
      accept: "application/xml,text/xml,*/*",
      "user-agent": "feynman-science-database-search/1.0 (https://github.com/Companion-Inc/feynman)"
    }
  });
  if (response.status === 404)
    return { status: 404 };
  if (!response.ok)
    throw new Error(`Europe PMC fullTextXML request failed: ${response.status} ${response.statusText}`);
  return { status: response.status, text: await response.text() };
}
function flagValue(value) {
  return String(value ?? "").trim().toUpperCase() === "Y";
}
function articleUrl(source, id, pmcid) {
  if (pmcid)
    return `https://europepmc.org/articles/${encodeURIComponent(pmcid)}`;
  if (source && id)
    return `https://europepmc.org/article/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
  return;
}
async function availabilityFor(input) {
  const url = new URL(`${EUROPE_PMC_REST_BASE2}/search`);
  url.searchParams.set("query", input.type === "pmid" ? `EXT_ID:${input.inputId} AND SRC:MED` : `PMCID:${input.inputId}`);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("pageSize", "1");
  const payload = await fetchJson6(url);
  const hit = recordValue7(arrayValue4(recordValue7(payload.resultList).result)[0]);
  const pmid = stringValue7(hit.pmid) ?? stringValue7(hit.id);
  const pmcid = stringValue7(hit.pmcid)?.toUpperCase();
  const exact = input.type === "pmid" ? pmid === input.inputId : pmcid === input.inputId;
  if (!exact) {
    return {
      endpoint: url.toString(),
      record: {
        inputId: input.inputId,
        inputIdType: input.type,
        found: false,
        fullTextAvailable: false,
        fullTextStatus: "not_found",
        detail: "ID did not resolve via the Europe PMC search endpoint."
      }
    };
  }
  const source = stringValue7(hit.source);
  const id = stringValue7(hit.id);
  return {
    endpoint: url.toString(),
    record: {
      inputId: input.inputId,
      inputIdType: input.type,
      found: true,
      id,
      source,
      pmid,
      pmcid,
      doi: stringValue7(hit.doi),
      title: stringValue7(hit.title),
      authors: stringValue7(hit.authorString),
      journal: stringValue7(hit.journalTitle) ?? stringValue7(recordValue7(recordValue7(hit.journalInfo).journal).title),
      publicationYear: numberValue6(hit.pubYear),
      isOpenAccess: flagValue(hit.isOpenAccess),
      inEuropePmc: flagValue(hit.inEPMC),
      inPmc: flagValue(hit.inPMC),
      license: stringValue7(hit.license),
      citedByCount: numberValue6(hit.citedByCount),
      abstract: truncateText2(stringValue7(hit.abstractText), ABSTRACT_SNIPPET_CHARS),
      url: articleUrl(source, id, pmcid)
    }
  };
}
function nodeText(value, excludedKeys = new Set) {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return value.map((item) => nodeText(item, excludedKeys)).join(" ");
  const record = recordValue7(value);
  return Object.entries(record).filter(([key]) => key === "#text" || !key.startsWith("@_") && key !== "#text").filter(([key]) => !excludedKeys.has(key)).map(([, item]) => nodeText(item, excludedKeys)).join(" ").replace(/\s+/g, " ").trim();
}
function findFirst(value, key) {
  const record = recordValue7(value);
  if (Object.prototype.hasOwnProperty.call(record, key))
    return record[key];
  for (const item of Object.values(record)) {
    if (Array.isArray(item)) {
      for (const child of item) {
        const found = findFirst(child, key);
        if (found !== undefined)
          return found;
      }
      continue;
    }
    if (item && typeof item === "object") {
      const found = findFirst(item, key);
      if (found !== undefined)
        return found;
    }
  }
  return;
}
function collectNodes(value, key, out = []) {
  const record = recordValue7(value);
  for (const [childKey, childValue] of Object.entries(record)) {
    if (childKey === key)
      out.push(...arrayValue4(childValue));
    if (Array.isArray(childValue))
      childValue.forEach((item) => collectNodes(item, key, out));
    else if (childValue && typeof childValue === "object")
      collectNodes(childValue, key, out);
  }
  return out;
}
function countRefs(value, parentKey) {
  const record = recordValue7(value);
  let total = 0;
  for (const [key, childValue] of Object.entries(record)) {
    if (key === "ref" && parentKey === "ref-list")
      total += arrayValue4(childValue).length;
    for (const child of arrayValue4(childValue)) {
      if (child && typeof child === "object")
        total += countRefs(child, key);
    }
  }
  return total;
}
function classifySection(title, secType) {
  const byType = {
    conclusion: "conclusion",
    conclusions: "conclusion",
    discussion: "discussion",
    intro: "introduction",
    introduction: "introduction",
    methods: "methods",
    results: "results"
  };
  const typeMatch = secType ? byType[secType.trim().toLowerCase()] : undefined;
  if (typeMatch)
    return typeMatch;
  const normalized = (title ?? "").trim().toLowerCase().replace(/^[0-9ivx]+[.):\s]+/, "");
  if (/^(introduction|background)\b/.test(normalized))
    return "introduction";
  if (/^(materials?\s+and\s+methods?|methods?|methodology|experimental procedures?|online methods)\b/.test(normalized))
    return "methods";
  if (/^results?\s+and\s+discussion\b/.test(normalized))
    return "results_and_discussion";
  if (/^(results?|findings)\b/.test(normalized))
    return "results";
  if (/^discussion\b/.test(normalized))
    return "discussion";
  if (/^(conclusions?|summary)\b/.test(normalized))
    return "conclusion";
  return "other";
}
function parseJats(xml) {
  const parsed = recordValue7(xmlParser3.parse(xml));
  const article = recordValue7(parsed.article);
  const body = recordValue7(findFirst(article, "body"));
  const sectionNodes = arrayValue4(body.sec);
  const sections = sectionNodes.map((section, index) => {
    const record = recordValue7(section);
    const title = truncateText2(nodeText(record.title), 240);
    const text = nodeText(record, new Set(["fig", "table-wrap", "ref-list"]));
    return {
      index,
      title,
      secType: stringValue7(record["@_sec-type"]),
      imrad: classifySection(title, stringValue7(record["@_sec-type"])),
      charCount: text.length,
      textSnippet: truncateText2(text, SECTION_TEXT_SNIPPET_CHARS2)
    };
  });
  const figureCaptions = collectNodes(article, "fig").slice(0, MAX_CAPTIONS_RETURNED).map((node) => {
    const record = recordValue7(node);
    return {
      id: stringValue7(record["@_id"]),
      label: truncateText2(nodeText(record.label), 80),
      caption: truncateText2(nodeText(record.caption), 600)
    };
  });
  const tableCaptions = collectNodes(article, "table-wrap").slice(0, MAX_CAPTIONS_RETURNED).map((node) => {
    const record = recordValue7(node);
    return {
      id: stringValue7(record["@_id"]),
      label: truncateText2(nodeText(record.label), 80),
      caption: truncateText2(nodeText(record.caption), 600)
    };
  });
  const abstractCandidates = arrayValue4(findFirst(article, "abstract"));
  const abstract = truncateText2(nodeText(abstractCandidates[0]), ABSTRACT_SNIPPET_CHARS);
  return {
    title: truncateText2(nodeText(findFirst(article, "article-title")), 500),
    abstract,
    sectionCount: sections.length,
    sectionInventory: sections.map((section) => ({
      index: section.index,
      title: section.title,
      imrad: section.imrad,
      charCount: section.charCount
    })),
    sections: sections.slice(0, MAX_SECTIONS_RETURNED2),
    figureCaptions,
    tableCaptions,
    nFigures: collectNodes(article, "fig").length,
    nTables: collectNodes(article, "table-wrap").length,
    nReferences: countRefs(article)
  };
}
async function fetchArticle(input, deadlineMs) {
  if (input.type === "unknown") {
    return {
      endpoints: [],
      result: {
        inputId: input.inputId,
        inputIdType: "unknown",
        found: false,
        fullTextAvailable: false,
        fullTextStatus: "invalid_id",
        detail: "Unrecognized ID format. Expected a PMID, PMCID, or supported PubMed Central/Europe PMC URL."
      }
    };
  }
  const availability = await availabilityFor(input);
  const result = { ...availability.record };
  const pmcid = stringValue7(result.pmcid);
  if (!result.found)
    return { endpoints: [availability.endpoint], result };
  if (!result.isOpenAccess) {
    return {
      endpoints: [availability.endpoint],
      result: {
        ...result,
        fullTextAvailable: false,
        fullTextStatus: "not_open_access",
        detail: "isOpenAccess=N: not in the Europe PMC open-access full-text subset."
      }
    };
  }
  if (!pmcid) {
    return {
      endpoints: [availability.endpoint],
      result: {
        ...result,
        fullTextAvailable: false,
        fullTextStatus: "no_pmcid",
        detail: "No PMCID assigned; fullTextXML requires a PMCID."
      }
    };
  }
  if (Date.now() >= deadlineMs) {
    return {
      endpoints: [availability.endpoint],
      result: {
        ...result,
        fullTextAvailable: false,
        fullTextStatus: "not_processed",
        detail: "Deadline elapsed before fullTextXML fetch; retry with fewer IDs."
      }
    };
  }
  const xmlUrl = new URL(`${EUROPE_PMC_REST_BASE2}/${encodeURIComponent(pmcid)}/fullTextXML`);
  const fetched = await fetchText3(xmlUrl);
  if (fetched.status !== 200 || !fetched.text) {
    return {
      endpoints: [availability.endpoint, xmlUrl.toString()],
      result: {
        ...result,
        fullTextAvailable: false,
        fullTextStatus: "xml_not_available",
        detail: `fullTextXML returned HTTP ${fetched.status} for ${pmcid}.`
      }
    };
  }
  const parsed = parseJats(fetched.text);
  return {
    endpoints: [availability.endpoint, xmlUrl.toString()],
    result: {
      ...result,
      fullTextAvailable: true,
      fullTextStatus: "retrieved",
      rawXmlBytes: fetched.text.length,
      title: stringValue7(parsed.title) ?? result.title,
      abstract: stringValue7(parsed.abstract) ?? result.abstract,
      sectionCount: parsed.sectionCount,
      sectionInventory: parsed.sectionInventory,
      sections: parsed.sections,
      figureCaptions: parsed.figureCaptions,
      tableCaptions: parsed.tableCaptions,
      nFigures: parsed.nFigures,
      nTables: parsed.nTables,
      nReferences: parsed.nReferences,
      contentPolicy: "Returned section snippets are bounded; raw fullTextXML is not included in tool output."
    }
  };
}
async function searchEuropePmcFullText(params) {
  const query = params.query.trim();
  if (!query)
    throw new Error("Europe PMC full-text lookup requires a non-empty query.");
  const limit = safeLimit4(params.limit);
  const inputs = parseInputIds(query, limit);
  const fetched = [];
  const deadlineMs = Date.now() + DEADLINE_MS;
  for (const input of inputs) {
    fetched.push(await fetchArticle(input, deadlineMs));
  }
  const results = fetched.map((item) => item.result);
  const endpoints = fetched.flatMap((item) => item.endpoints);
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "europepmc",
    query,
    mode: "fulltext",
    totalCount: results.length,
    returned: results.length,
    results,
    provenance: {
      docs: EUROPE_PMC_DOCS2,
      endpoints
    }
  };
}

// vendor/upstream/science-databases.ts
var CROSSREF_BASE = "https://api.crossref.org";
var EUROPE_PMC_SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
var SEMANTIC_SCHOLAR_BASE = "https://api.semanticscholar.org/graph/v1";
var SEMANTIC_SCHOLAR_FIELDS = "title,year,authors,venue,citationCount,externalIds,openAccessPdf,abstract";
var SEMANTIC_SCHOLAR_KEY_URL = "https://www.semanticscholar.org/product/api#api-key-form";
var SEMANTIC_SCHOLAR_ABSTRACT_CHARS = 600;
var SEMANTIC_SCHOLAR_DEFAULT_RETRY_MS = 1000;
var SEMANTIC_SCHOLAR_MAX_RETRY_MS = 5000;
var DEFAULT_LIMIT5 = 5;
var MAX_LIMIT5 = 20;
var REQUEST_TIMEOUT_MS7 = 25000;
var SCIENCE_DATABASE_SOURCE_IDS = [
  "arxiv",
  "biorxiv",
  "crossref",
  "europepmc",
  "medrxiv",
  "openalex",
  "pubmed",
  "semanticscholar"
];
var SCIENCE_DATABASE_SOURCE_SCHEMA = Type3.Unsafe({
  description: "Database to search.",
  enum: [...SCIENCE_DATABASE_SOURCE_IDS],
  type: "string"
});
function formatText3(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function recordValue8(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function arrayValue5(value) {
  return Array.isArray(value) ? value : [];
}
function stringValue8(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function numberValue7(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return;
}
function safeLimit5(value) {
  if (!Number.isFinite(value) || value === undefined)
    return DEFAULT_LIMIT5;
  return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT5));
}
function cleanQuery5(query) {
  const clean = query.trim();
  if (!clean)
    throw new Error("Science database search requires a non-empty query.");
  return clean;
}

class ScienceDatabaseRequestError extends Error {
  status;
  retryAfterMs;
  constructor(message, status, retryAfterMs) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
function retryAfterMs(value) {
  const seconds = numberValue7(value ?? undefined);
  return seconds === undefined || seconds < 0 ? undefined : seconds * 1000;
}
async function fetchJson7(url, headers = {}) {
  const controller = new AbortController;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS7);
  try {
    const response = await researchFetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new ScienceDatabaseRequestError(`${url.hostname} request failed: ${response.status} ${response.statusText}`, response.status, retryAfterMs(response.headers.get("retry-after")));
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}
function firstString(value) {
  if (typeof value === "string")
    return stringValue8(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstString(item);
      if (text)
        return text;
    }
  }
  return;
}
function dateParts(value) {
  const parts = arrayValue5(recordValue8(value)["date-parts"])[0];
  if (!Array.isArray(parts))
    return;
  return parts.map((part) => String(part).padStart(2, "0")).join("-");
}
function doiUrl3(doi) {
  return doi ? `https://doi.org/${doi}` : undefined;
}
function crossrefAuthors(value) {
  return arrayValue5(value).map((author) => {
    const record = recordValue8(author);
    return [stringValue8(record.given), stringValue8(record.family)].filter(Boolean).join(" ") || stringValue8(record.name);
  }).filter((name) => Boolean(name)).slice(0, 8);
}
var crossrefPacer = createRequestPacer();
function withCrossrefPacing(polite, run) {
  return crossrefPacer(polite ? 400 : 1200, run);
}
async function searchCrossref(params) {
  const query = cleanQuery5(params.query);
  const limit = safeLimit5(params.limit);
  const url = new URL(`${CROSSREF_BASE}/works`);
  const mailto = process.env.CROSSREF_MAILTO?.trim() || process.env.NCBI_EMAIL?.trim();
  url.search = new URLSearchParams({
    query,
    rows: String(limit),
    select: "DOI,title,published-print,published-online,issued,container-title,author,is-referenced-by-count,URL,type",
    ...mailto ? { mailto } : {}
  }).toString();
  const request = () => withCrossrefPacing(Boolean(mailto), () => fetchJson7(url));
  let payload;
  try {
    try {
      payload = recordValue8(await request());
    } catch (error) {
      if (!(error instanceof ScienceDatabaseRequestError) || error.status !== 429)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(error.retryAfterMs ?? 1500, 5000)));
      payload = recordValue8(await request());
    }
  } catch (error) {
    if (!(error instanceof ScienceDatabaseRequestError) || error.status !== 429)
      throw error;
    throw new Error(mailto ? "Crossref rate-limited this request (HTTP 429). Wait a few seconds and retry, or look the DOI up with source openalex." : "Crossref's public pool rate-limited this request (HTTP 429). Set CROSSREF_MAILTO to your email for Crossref's faster polite pool, wait and retry, or look the DOI up with source openalex.");
  }
  const message = recordValue8(payload.message);
  const results = arrayValue5(message.items).flatMap((item) => {
    const record = recordValue8(item);
    const doi = stringValue8(record.DOI);
    return [{
      doi,
      title: firstString(record.title),
      container: firstString(record["container-title"]),
      type: stringValue8(record.type),
      publicationDate: dateParts(record["published-print"]) ?? dateParts(record["published-online"]) ?? dateParts(record.issued),
      authors: crossrefAuthors(record.author),
      citationCount: numberValue7(record["is-referenced-by-count"]),
      url: stringValue8(record.URL) ?? doiUrl3(doi),
      ...doiUrl3(doi) ? { doiUrl: doiUrl3(doi) } : {}
    }];
  });
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "crossref",
    query,
    totalCount: numberValue7(message["total-results"]) ?? results.length,
    returned: results.length,
    results,
    provenance: {
      docs: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/",
      endpoints: [url.toString()]
    }
  };
}
async function searchEuropePmc(params) {
  const query = cleanQuery5(params.query);
  const limit = safeLimit5(params.limit);
  if (isEuropePmcFullTextQuery(query))
    return searchEuropePmcFullText({ limit, query });
  const url = new URL(EUROPE_PMC_SEARCH_URL);
  url.search = new URLSearchParams({
    query,
    resultType: "lite",
    cursorMark: "*",
    pageSize: String(limit),
    format: "json"
  }).toString();
  const payload = recordValue8(await fetchJson7(url));
  const results = arrayValue5(recordValue8(payload.resultList).result).flatMap((item) => {
    const record = recordValue8(item);
    const id = stringValue8(record.id);
    const source = stringValue8(record.source);
    if (!id || !source)
      return [];
    const doi = stringValue8(record.doi);
    return [{
      id,
      source,
      pmid: stringValue8(record.pmid),
      pmcid: stringValue8(record.pmcid),
      doi,
      title: stringValue8(record.title),
      authors: stringValue8(record.authorString),
      journal: stringValue8(record.journalTitle),
      publicationYear: numberValue7(record.pubYear),
      publicationType: stringValue8(record.pubType),
      citedByCount: numberValue7(record.citedByCount),
      isOpenAccess: record.isOpenAccess === "Y",
      inPmc: record.inPMC === "Y",
      hasReferences: record.hasReferences === "Y",
      hasTextMinedTerms: record.hasTextMinedTerms === "Y",
      url: `https://europepmc.org/article/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
      ...doiUrl3(doi) ? { doiUrl: doiUrl3(doi) } : {}
    }];
  });
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "europepmc",
    query,
    totalCount: numberValue7(payload.hitCount) ?? results.length,
    returned: results.length,
    hasMore: Boolean(stringValue8(payload.nextCursorMark)),
    results,
    provenance: {
      docs: "https://europepmc.org/RestfulWebService",
      endpoints: [url.toString()]
    }
  };
}
async function fetchSemanticScholar(url) {
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
  const headers = apiKey ? { "x-api-key": apiKey } : {};
  for (let attempt = 0;; attempt += 1) {
    try {
      return await fetchJson7(url, headers);
    } catch (error) {
      if (apiKey && error instanceof ScienceDatabaseRequestError && error.status === 403) {
        throw new ScienceDatabaseRequestError("Semantic Scholar rejected SEMANTIC_SCHOLAR_API_KEY (HTTP 403). Check the key, or unset it to use the shared pool; search with source openalex meanwhile.", 403);
      }
      if (!(error instanceof ScienceDatabaseRequestError) || error.status !== 429)
        throw error;
      if (attempt >= 1) {
        throw new ScienceDatabaseRequestError(apiKey ? "Semantic Scholar rate-limited this API key (HTTP 429) after one retry. Wait and retry, or search with source openalex." : `Semantic Scholar's shared anonymous pool is rate-limited (HTTP 429) after one retry. Set SEMANTIC_SCHOLAR_API_KEY (free key: ${SEMANTIC_SCHOLAR_KEY_URL}) or search with source openalex.`, 429);
      }
      const waitMs = Math.min(error.retryAfterMs ?? SEMANTIC_SCHOLAR_DEFAULT_RETRY_MS, SEMANTIC_SCHOLAR_MAX_RETRY_MS);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
function truncateText3(value, maxChars) {
  if (!value || value.length <= maxChars)
    return value;
  return `${value.slice(0, maxChars).trimEnd()}…`;
}
function parseSemanticScholarQuery(raw) {
  let from = "";
  let to = "";
  const query = raw.replace(/^\s*semantic:\s*/i, "").replace(/\byear_(from|to)=(\d{4})\b/gi, (_match, kind, year) => {
    if (kind.toLowerCase() === "from")
      from = year;
    else
      to = year;
    return " ";
  }).replace(/\s+/g, " ").trim();
  return from || to ? { query, year: `${from}-${to}` } : { query };
}
function semanticScholarSearchUrl(query, limit, sort, year) {
  const relevance = sort === "relevance";
  const url = new URL(`${SEMANTIC_SCHOLAR_BASE}/paper/search${relevance ? "" : "/bulk"}`);
  url.search = new URLSearchParams({
    query,
    fields: SEMANTIC_SCHOLAR_FIELDS,
    ...year ? { year } : {},
    ...relevance ? { limit: String(limit) } : { sort }
  }).toString();
  return url;
}
function semanticScholarRecord(item) {
  const record = recordValue8(item);
  const paperId = stringValue8(record.paperId);
  if (!paperId)
    return [];
  const externalIds = recordValue8(record.externalIds);
  const doi = stringValue8(externalIds.DOI);
  return [{
    paperId,
    title: stringValue8(record.title),
    year: numberValue7(record.year),
    authors: arrayValue5(record.authors).map((author) => stringValue8(recordValue8(author).name)).filter(Boolean).slice(0, 8),
    venue: stringValue8(record.venue),
    citationCount: numberValue7(record.citationCount),
    doi,
    arxivId: stringValue8(externalIds.ArXiv),
    pmid: stringValue8(externalIds.PubMed),
    openAccessPdf: stringValue8(recordValue8(record.openAccessPdf).url),
    abstract: truncateText3(stringValue8(record.abstract), SEMANTIC_SCHOLAR_ABSTRACT_CHARS),
    url: `https://www.semanticscholar.org/paper/${paperId}`,
    ...doiUrl3(doi) ? { doiUrl: doiUrl3(doi) } : {}
  }];
}
async function searchSemanticScholar(params) {
  const { query, year } = parseSemanticScholarQuery(cleanQuery5(params.query));
  const limit = safeLimit5(params.limit);
  let sort = params.sort === "relevance" ? "relevance" : params.sort === "pub_date" ? "publicationDate:desc" : "citationCount:desc";
  const endpoints = [semanticScholarSearchUrl(query, limit, sort, year)];
  let note;
  let payload;
  try {
    payload = recordValue8(await fetchSemanticScholar(endpoints[0]));
  } catch (error) {
    const anonymous = !process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
    if (sort !== "relevance" || !anonymous || !(error instanceof ScienceDatabaseRequestError) || error.status !== 429)
      throw error;
    sort = "citationCount:desc";
    endpoints.push(semanticScholarSearchUrl(query, limit, sort, year));
    note = `Relevance search was rate-limited (HTTP 429) on Semantic Scholar's shared anonymous pool, so these are citation-sorted bulk results. A free SEMANTIC_SCHOLAR_API_KEY avoids this: ${SEMANTIC_SCHOLAR_KEY_URL}`;
    payload = recordValue8(await fetchSemanticScholar(endpoints[1]));
  }
  const results = arrayValue5(payload.data).slice(0, limit).flatMap(semanticScholarRecord);
  return {
    schema: "feynman.scienceDatabaseSearch.v1",
    source: "semanticscholar",
    query,
    ...year ? { year } : {},
    sort,
    ...note ? { note } : {},
    totalCount: numberValue7(payload.total) ?? results.length,
    returned: results.length,
    results,
    provenance: {
      docs: "https://api.semanticscholar.org/api-docs/graph",
      license: "https://www.semanticscholar.org/product/api/license",
      endpoints: endpoints.map((endpoint) => endpoint.toString())
    }
  };
}
var OPENALEX_LOOKUP_QUERY = /^(?:openalex_\w+|rate-limit|authors?|author-search|sources?|venues?|citations?|references?|work|detail)(?::|\s|$)|^(?:W\d+|doi:\s*10\.|10\.\S+\/)/i;
function isTimeout(error) {
  return error instanceof Error && error.name === "AbortError";
}
function isIndexUnavailable(error) {
  if (isTimeout(error))
    return true;
  if (error instanceof ScienceDatabaseRequestError)
    return error.status === 429 || error.status >= 500;
  return error instanceof Error && /^OpenAlex request failed: (?:429|5\d\d)\b/.test(error.message);
}
async function withIndexFallback(run, fallback, describe) {
  try {
    return await run();
  } catch (error) {
    if (!fallback || !isIndexUnavailable(error))
      throw error;
    let result;
    try {
      result = await fallback();
    } catch {
      throw error;
    }
    return { fallbackNote: describe(error instanceof Error ? error.message : String(error)), ...result };
  }
}
async function semanticScholarByArxivIds(ids) {
  const endpoints = [];
  const results = [];
  const notFound = [];
  for (const id of ids.slice(0, 10)) {
    const bare = id.replace(/v\d+$/, "");
    const url = new URL(`${SEMANTIC_SCHOLAR_BASE}/paper/ARXIV:${bare}`);
    url.searchParams.set("fields", SEMANTIC_SCHOLAR_FIELDS);
    endpoints.push(url.toString());
    try {
      results.push(...semanticScholarRecord(await fetchSemanticScholar(url)));
    } catch (error) {
      if (!(error instanceof ScienceDatabaseRequestError) || error.status !== 404)
        throw error;
      notFound.push(id);
    }
  }
  return { schema: "feynman.scienceDatabaseSearch.v1", source: "semanticscholar", query: ids.join(","), not_found: notFound, results, provenance: { endpoints } };
}
async function searchArxivWithFallback(params) {
  try {
    return await searchArxiv(params);
  } catch (error) {
    if (error instanceof ArxivTopicQueryError) {
      const result = await searchOpenAlex({ limit: params.limit, query: `semantic: ${error.topic}`, source: "openalex" });
      return { fallbackNote: "The arxiv source only looks up papers by ID, so this topic was searched with OpenAlex semantic search instead.", ...result };
    }
    if (error instanceof ArxivUnavailableError) {
      let result;
      try {
        result = await semanticScholarByArxivIds(error.ids);
      } catch {
        throw error;
      }
      return { fallbackNote: `arXiv was unavailable (${error.message}); these records are from Semantic Scholar.`, ...result };
    }
    throw error;
  }
}
async function withArxivDoiFallback(params, run) {
  try {
    return await run();
  } catch (error) {
    const arxivId = error instanceof Error ? /^OpenAlex has no work for doi:10\.48550\/arxiv\.(.+)$/i.exec(error.message)?.[1] : undefined;
    if (!arxivId)
      throw error;
    const result = await searchArxivWithFallback({ ...params, source: "arxiv", query: arxivId });
    return { fallbackNote: `OpenAlex has no record of this arXiv DOI yet, so it was looked up on arXiv (${arxivId}).`, ...result };
  }
}
async function scienceDatabaseSearch(params) {
  if (params.source === "arxiv")
    return searchArxivWithFallback(params);
  if (params.source === "biorxiv")
    return searchPreprints(params, "biorxiv");
  if (params.source === "medrxiv")
    return searchPreprints(params, "medrxiv");
  if (params.source === "pubmed")
    return searchPubMed(params);
  if (params.source === "crossref")
    return searchCrossref(params);
  const openAlex = () => searchOpenAlex({ limit: params.limit, query: params.query, source: "openalex" });
  const semanticScholar = () => searchSemanticScholar({ ...params, source: "semanticscholar" });
  if (params.source === "semanticscholar") {
    return withIndexFallback(semanticScholar, openAlex, (reason) => `Semantic Scholar was unavailable (${reason}); these results are from OpenAlex.`);
  }
  if (params.source === "openalex") {
    return withArxivDoiFallback(params, () => withIndexFallback(openAlex, OPENALEX_LOOKUP_QUERY.test(params.query.trim()) ? undefined : semanticScholar, (reason) => `OpenAlex was unavailable (${reason}); these results are from Semantic Scholar.`));
  }
  return searchEuropePmc(params);
}
function registerScienceDatabaseTools(pi) {
  pi.registerTool({
    name: "feynman_science_database_search",
    label: "Science Database Search",
    description: "Search read-only scholarly literature databases: Semantic Scholar (citation-sorted by default), OpenAlex, arXiv ID lookup, PubMed (search, metadata, ID conversion, related articles, citation matching, copyright, PMC full-text routing), Europe PMC (metadata and open-access full-text sections), bioRxiv/medRxiv preprints, and Crossref DOI metadata. Returns stable identifiers, bounded section snippets when requested, source URLs, and endpoint provenance.",
    promptSnippet: "Search Semantic Scholar, OpenAlex, PubMed, Europe PMC metadata and open-access full-text sections, bioRxiv/medRxiv, or Crossref, or look up arXiv IDs, for source-backed literature evidence.",
    promptGuidelines: [
      "Use feynman_science_database_search to find and pin down papers before making source-backed claims: Semantic Scholar for general discovery (prefer the default citation-count sort, which surfaces seminal work and is the least rate-limited; use sort=pub_date only when recency matters); OpenAlex for cross-discipline works (prefix the query with `semantic:` for embedding search that finds conceptual and recent matches keyword search misses), citation graphs, authors, venues, and OA status; arXiv only to look up known arXiv IDs (it has no topic search); PubMed for biomedical search, PMID metadata, PMID/PMCID/DOI conversion, related articles, citation matching, and copyright checks; Europe PMC for open-access full-text section snippets; bioRxiv/medRxiv for preprint DOI lookup, date/category windows, and published-preprint links; Crossref for DOI metadata.",
      "Exact literature modes: `openalex_search_works`, `openalex_get_work`, `openalex_citations`, `openalex_references`, `openalex_search_authors`, `openalex_get_author`, `openalex_venue_info`, and `arxiv_get_papers` (the arxiv source also accepts bare IDs such as 2309.08600). PubMed accepts `pmid:`, `convert:`, `related:`, `fulltext:`, `copyright:`, and `citation` prefixes; Europe PMC accepts `fulltext:`/`sections:` with a PMCID or PMID.",
      "Preserve returned PMIDs, PMCIDs, DOIs, arXiv IDs, Semantic Scholar paper IDs, preprint DOIs, OpenAlex W/A/S IDs, author ORCIDs, citation/reference counts, OA status, Europe PMC full-text statuses and section inventories, source URLs, and endpoint provenance in research artifacts and answers.",
      "Treat database summaries as retrieval evidence, then verify decisive claims against the full paper when needed."
    ],
    prepareArguments: (args) => {
      if (!args || typeof args !== "object" || Array.isArray(args))
        return args;
      const input = { ...args };
      for (const key of ["sort", "limit"]) {
        if (input[key] === null || input[key] === "" || input[key] === "null")
          delete input[key];
      }
      if (typeof input.sort === "string")
        input.sort = input.sort.trim().toLowerCase();
      if (typeof input.limit === "string" && /^\d+$/.test(input.limit.trim()))
        input.limit = Number(input.limit);
      return input;
    },
    parameters: Type3.Object({
      source: SCIENCE_DATABASE_SOURCE_SCHEMA,
      query: Type3.String({
        description: "Search query, exact literature command, identifier, paper title, or DOI. Examples: semantic: spending more inference compute instead of a bigger model year_from=2024, openalex_search_works:CRISPR year_from=2024 open_access_only=true, openalex_get_work:W2741809807, openalex_citations:W2741809807, openalex_search_authors:Jennifer Doudna, arxiv_get_papers:2309.08600,2401.00001, pmid:35486828, convert:35486828 id_type=pmid, fulltext:PMC9046468, citation journal=Nature year=2022 volume=604 first_page=123 author=Doudna."
      }),
      limit: Type3.Optional(Type3.Number({ description: `Maximum records to return. Defaults to ${DEFAULT_LIMIT5}, max ${MAX_LIMIT5}.` })),
      sort: Type3.Optional(Type3.Union([
        Type3.Literal("relevance"),
        Type3.Literal("pub_date")
      ], { description: "PubMed sort order. For semanticscholar, prefer the default citation-count sort; use pub_date (newest first) only when recency matters. relevance falls back to the default when the anonymous pool is rate-limited. Ignored for other sources." }))
    }),
    async execute(_toolCallId, params) {
      let result;
      try {
        result = await scienceDatabaseSearch(params);
      } catch (error) {
        if (!isTimeout(error))
          throw error;
        throw new Error(`${params.source} did not respond within ${REQUEST_TIMEOUT_MS7 / 1000} s. Retry, or search another source.`);
      }
      return {
        content: [{ type: "text", text: formatText3(result) }],
        details: result
      };
    }
  });
}
// vendor/upstream/docx-fallback.ts
import { inflateRawSync } from "node:zlib";
function readZipEntry(zip, name) {
  const end = zip.lastIndexOf(Buffer.from([80, 75, 5, 6]));
  if (end < 0)
    return;
  let offset = zip.readUInt32LE(end + 16);
  for (let index = zip.readUInt16LE(end + 10);index > 0; index -= 1) {
    if (zip.readUInt32LE(offset) !== 33639248)
      return;
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    if (zip.toString("utf8", offset + 46, offset + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: 16 * 1024 * 1024 }) : undefined;
    }
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return;
}
function decodeXml(text) {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_match, hex, dec, named) => {
    if (hex)
      return String.fromCodePoint(Number.parseInt(hex, 16));
    if (dec)
      return String.fromCodePoint(Number(dec));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[named.toLowerCase()] ?? "";
  });
}
function docxText(file) {
  const xml = readZipEntry(file, "word/document.xml")?.toString("utf8");
  if (!xml)
    return;
  return xml.split("</w:p>").map((paragraph) => [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((match) => match[0] === "<w:tab/>" ? "\t" : match[0] === "<w:br/>" ? `
` : decodeXml(match[1] ?? "")).join("")).join(`
`).replace(/\n{3,}/g, `

`).trim();
}
// vendor/docparser/native-executor.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// vendor/docparser/native-protocol.mjs
import { isAbsolute, relative } from "node:path";
var PROTOCOL_VERSION = 1;
var REQUEST_MAX_BYTES = 64 * 1024;
var RESPONSE_MAX_BYTES = 1024 * 1024;
var OPERATIONS = new Set(["parse", "search", "screenshot"]);

class ProtocolValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new ProtocolValidationError(`${label} contains unknown field: ${key}`);
  }
  for (const key of required) {
    if (!(key in value))
      throw new ProtocolValidationError(`${label} is missing field: ${key}`);
  }
}
function assertString(value, label) {
  if (typeof value !== "string")
    throw new ProtocolValidationError(`${label} must be a string.`);
  return value;
}
function assertNonemptyString(value, label) {
  const text = assertString(value, label);
  if (!text)
    throw new ProtocolValidationError(`${label} must not be empty.`);
  return text;
}
function assertBoolean(value, label) {
  if (typeof value !== "boolean")
    throw new ProtocolValidationError(`${label} must be a boolean.`);
  return value;
}
function assertInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ProtocolValidationError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
function assertFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolValidationError(`${label} must be finite.`);
  }
  return value;
}
function assertAbsolutePath(value, label) {
  const path = assertNonemptyString(value, label);
  if (!isAbsolute(path))
    throw new ProtocolValidationError(`${label} must be absolute.`);
  return path;
}
function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function validateConfig(value) {
  if (!isRecord(value))
    throw new ProtocolValidationError("request.config must be an object.");
  const required = [
    "outputFormat",
    "ocrEnabled",
    "numWorkers",
    "maxPages",
    "dpi",
    "preserveVerySmallText",
    "quiet"
  ];
  const optional = ["ocrLanguage", "ocrServerUrl", "targetPages", "password", "tessdataPath"];
  assertKeys(value, required, optional, "request.config");
  if (value.outputFormat !== "text" && value.outputFormat !== "json") {
    throw new ProtocolValidationError("request.config.outputFormat must be text or json.");
  }
  assertBoolean(value.ocrEnabled, "request.config.ocrEnabled");
  assertInteger(value.numWorkers, "request.config.numWorkers", 1, 8);
  assertInteger(value.maxPages, "request.config.maxPages", 1, 1000);
  assertInteger(value.dpi, "request.config.dpi", 72, 300);
  assertBoolean(value.preserveVerySmallText, "request.config.preserveVerySmallText");
  if (value.quiet !== true)
    throw new ProtocolValidationError("request.config.quiet must be true.");
  for (const key of optional) {
    if (key in value)
      assertString(value[key], `request.config.${key}`);
  }
  if (typeof value.targetPages === "string" && Buffer.byteLength(value.targetPages, "utf8") > 16 * 1024) {
    throw new ProtocolValidationError("request.config.targetPages exceeds its UTF-8 byte limit.");
  }
}
function validateWorkerRequest(value) {
  if (!isRecord(value))
    throw new ProtocolValidationError("Request must be an object.");
  if (value.version !== PROTOCOL_VERSION)
    throw new ProtocolValidationError("Unsupported protocol version.");
  const operation = assertNonemptyString(value.operation, "request.operation");
  if (!OPERATIONS.has(operation))
    throw new ProtocolValidationError("Unsupported operation.");
  assertNonemptyString(value.jobId, "request.jobId");
  const inputPath = assertAbsolutePath(value.inputPath, "request.inputPath");
  const stagingDir = assertAbsolutePath(value.stagingDir, "request.stagingDir");
  if (inputPath === stagingDir)
    throw new ProtocolValidationError("Staging path must not equal the input path.");
  if (operation === "parse") {
    assertKeys(value, ["version", "operation", "jobId", "inputPath", "stagingDir", "outputPath", "config"], [], "parse request");
    const outputPath = assertAbsolutePath(value.outputPath, "request.outputPath");
    if (isInside(outputPath, stagingDir))
      throw new ProtocolValidationError("Published output must be outside staging.");
    validateConfig(value.config);
  } else if (operation === "search") {
    assertKeys(value, [
      "version",
      "operation",
      "jobId",
      "inputPath",
      "stagingDir",
      "phrase",
      "caseSensitive",
      "maxResults",
      "config"
    ], [], "search request");
    const phrase = assertNonemptyString(value.phrase, "request.phrase");
    if (!phrase.trim() || Buffer.byteLength(phrase, "utf8") > 4 * 1024) {
      throw new ProtocolValidationError("request.phrase is blank or exceeds its UTF-8 byte limit.");
    }
    assertBoolean(value.caseSensitive, "request.caseSensitive");
    assertInteger(value.maxResults, "request.maxResults", 1, 200);
    validateConfig(value.config);
  } else {
    assertKeys(value, ["version", "operation", "jobId", "inputPath", "stagingDir", "outputDir", "pages", "dpi"], ["password"], "screenshot request");
    const outputDir = assertAbsolutePath(value.outputDir, "request.outputDir");
    if (isInside(outputDir, stagingDir))
      throw new ProtocolValidationError("Published screenshot directory must be outside staging.");
    if (!Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 4) {
      throw new ProtocolValidationError("request.pages must contain between one and four pages.");
    }
    const seen = new Set;
    for (const page of value.pages) {
      const parsed = assertInteger(page, "request.pages entry", 1, 2 ** 32 - 1);
      if (seen.has(parsed))
        throw new ProtocolValidationError("request.pages must not contain duplicates.");
      seen.add(parsed);
    }
    assertInteger(value.dpi, "request.dpi", 72, 300);
    if ("password" in value)
      assertString(value.password, "request.password");
  }
  return value;
}
function validateHit(hit, label) {
  assertKeys(hit, ["pageNum", "text", "x", "y", "width", "height"], ["fontName", "fontSize", "confidence"], label);
  assertInteger(hit.pageNum, `${label}.pageNum`, 1, 2 ** 32 - 1);
  assertString(hit.text, `${label}.text`);
  for (const key of ["x", "y", "width", "height"])
    assertFinite(hit[key], `${label}.${key}`);
  if ("fontName" in hit)
    assertString(hit.fontName, `${label}.fontName`);
  for (const key of ["fontSize", "confidence"])
    if (key in hit)
      assertFinite(hit[key], `${label}.${key}`);
}
function validateWorkerResponse(value, request) {
  if (!isRecord(value))
    throw new ProtocolValidationError("Response must be an object.");
  assertKeys(value, ["version", "operation", "jobId", "ok", value.ok === true ? "result" : "error"], [], "response");
  if (value.version !== PROTOCOL_VERSION)
    throw new ProtocolValidationError("Response protocol version mismatch.");
  if (value.operation !== request.operation)
    throw new ProtocolValidationError("Response operation mismatch.");
  if (value.jobId !== request.jobId)
    throw new ProtocolValidationError("Response job id mismatch.");
  assertBoolean(value.ok, "response.ok");
  if (value.ok === false) {
    if (!isRecord(value.error))
      throw new ProtocolValidationError("response.error must be an object.");
    assertKeys(value.error, ["kind", "message"], [], "response.error");
    if (value.error.kind !== "ordinary")
      throw new ProtocolValidationError("response.error.kind must be ordinary.");
    assertNonemptyString(value.error.message, "response.error.message");
    return value;
  }
  if (!isRecord(value.result))
    throw new ProtocolValidationError("response.result must be an object.");
  const result = value.result;
  if (request.operation === "parse") {
    assertKeys(result, ["pageCount", "outputBytes", "outputPath"], [], "parse result");
    assertInteger(result.pageCount, "parse result.pageCount", 0, request.config.maxPages);
    assertInteger(result.outputBytes, "parse result.outputBytes", 0, 256 * 1024 * 1024);
    if (result.outputPath !== request.outputPath)
      throw new ProtocolValidationError("Parse output path mismatch.");
  } else if (request.operation === "search") {
    assertKeys(result, ["pageCount", "hits", "truncatedByCount", "truncatedByBytes"], [], "search result");
    assertInteger(result.pageCount, "search result.pageCount", 0, request.config.maxPages);
    if (!Array.isArray(result.hits) || result.hits.length > request.maxResults)
      throw new ProtocolValidationError("search result.hits is invalid.");
    result.hits.forEach((hit, index) => {
      if (!isRecord(hit))
        throw new ProtocolValidationError(`search result.hits[${index}] must be an object.`);
      validateHit(hit, `search result.hits[${index}]`);
    });
    assertBoolean(result.truncatedByCount, "search result.truncatedByCount");
    assertBoolean(result.truncatedByBytes, "search result.truncatedByBytes");
  } else {
    assertKeys(result, ["screenshotDir", "screenshots", "totalBytes"], [], "screenshot result");
    if (result.screenshotDir !== request.outputDir)
      throw new ProtocolValidationError("Screenshot output directory mismatch.");
    if (!Array.isArray(result.screenshots) || result.screenshots.length > 4)
      throw new ProtocolValidationError("screenshot result.screenshots is invalid.");
    if (result.screenshots.length !== request.pages.length) {
      throw new ProtocolValidationError("Screenshot result count does not match the request.");
    }
    let screenshotBytes = 0;
    const screenshotPages = new Set;
    result.screenshots.forEach((item, index) => {
      if (!isRecord(item))
        throw new ProtocolValidationError(`screenshot result.screenshots[${index}] must be an object.`);
      assertKeys(item, ["pageNum", "width", "height", "outputPath", "bytes"], [], `screenshot result.screenshots[${index}]`);
      assertInteger(item.pageNum, "screenshot pageNum", 1, 2 ** 32 - 1);
      if (!request.pages.includes(item.pageNum) || screenshotPages.has(item.pageNum)) {
        throw new ProtocolValidationError("Screenshot result pages do not match the request.");
      }
      screenshotPages.add(item.pageNum);
      assertFinite(item.width, "screenshot width");
      assertFinite(item.height, "screenshot height");
      assertAbsolutePath(item.outputPath, "screenshot outputPath");
      if (!isInside(item.outputPath, result.screenshotDir)) {
        throw new ProtocolValidationError("Screenshot output path is outside the published directory.");
      }
      screenshotBytes += assertInteger(item.bytes, "screenshot bytes", 0, 25 * 1024 * 1024);
    });
    assertInteger(result.totalBytes, "screenshot result.totalBytes", 0, 64 * 1024 * 1024);
    if (result.totalBytes !== screenshotBytes)
      throw new ProtocolValidationError("Screenshot byte total mismatch.");
  }
  return value;
}
function encodeFrame(value, maximum, label) {
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new ProtocolValidationError(`${label} is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (payload.byteLength > maximum)
    throw new ProtocolValidationError(`${label} exceeds the ${maximum}-byte frame limit.`);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}
async function readSingleFrame(stream, maximum, label) {
  let header = Buffer.alloc(0);
  let payload = Buffer.alloc(0);
  let declared;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : typeof rawChunk === "string" ? Buffer.from(rawChunk) : Buffer.from(rawChunk);
    let offset = 0;
    if (header.byteLength < 4) {
      const count = Math.min(4 - header.byteLength, chunk.byteLength);
      header = Buffer.concat([header, chunk.subarray(0, count)]);
      offset += count;
      if (header.byteLength === 4) {
        declared = header.readUInt32BE(0);
        if (declared > maximum)
          throw new ProtocolValidationError(`${label} declares ${declared} bytes, above the ${maximum}-byte frame limit.`);
      }
    }
    if (declared !== undefined && offset < chunk.byteLength) {
      const remaining = declared - payload.byteLength;
      const count = Math.min(remaining, chunk.byteLength - offset);
      if (count > 0)
        payload = Buffer.concat([payload, chunk.subarray(offset, offset + count)]);
      offset += count;
      if (offset < chunk.byteLength)
        throw new ProtocolValidationError(`${label} contains trailing data.`);
    }
  }
  if (header.byteLength !== 4)
    throw new ProtocolValidationError(`${label} ended before its frame header.`);
  if (declared === undefined || payload.byteLength !== declared)
    throw new ProtocolValidationError(`${label} ended before its declared payload.`);
  let value;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch (error) {
    throw new ProtocolValidationError(`${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return value;
}

// vendor/docparser/constants.ts
import { availableParallelism } from "node:os";
var PREVIEW_MAX_LINES = 20;
var PREVIEW_MAX_BYTES = 2 * 1024;
var DEFAULT_MAX_PAGES = 100;
var MAX_PAGES = 1000;
var DEFAULT_DPI = 150;
var MIN_DPI = 72;
var MAX_DPI = 300;
var DEFAULT_NUM_WORKERS = Math.min(4, Math.max(1, availableParallelism() - 1));
var MAX_NUM_WORKERS = 8;
var DEFAULT_MAX_RESULTS = 50;
var MAX_RESULTS = 200;
var MAX_SEARCH_PHRASE_BYTES = 4 * 1024;
var MAX_PAGE_SELECTION_BYTES = 16 * 1024;
var MAX_PAGE_SELECTION_TOKENS = 1000;
var MAX_PAGE_SELECTION_EXPANSION = 1000;
var MAX_PAGE_NUMBER = 2 ** 32 - 1;
var MAX_SCREENSHOT_PAGES = 4;
var WORKER_TIMEOUT_MS = 10 * 60 * 1000;
var IPC_REQUEST_MAX_BYTES = 64 * 1024;
var IPC_RESPONSE_MAX_BYTES = 1024 * 1024;
var STDERR_TAIL_MAX_BYTES = 64 * 1024;
var PARSED_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
var SCREENSHOT_FILE_MAX_BYTES = 25 * 1024 * 1024;
var SCREENSHOT_JOB_MAX_BYTES = 64 * 1024 * 1024;
var INLINE_PNG_MAX_BYTES = 3 * 1024 * 1024;
var INLINE_PNG_TOTAL_MAX_BYTES = 12 * 1024 * 1024;
var INSTALL_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
var OFFICE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".docm",
  ".odt",
  ".rtf",
  ".pages",
  ".ppt",
  ".pptx",
  ".pptm",
  ".odp",
  ".key"
]);
var SPREADSHEET_EXTENSIONS = new Set([
  ".xls",
  ".xlsx",
  ".xlsm",
  ".ods",
  ".csv",
  ".tsv",
  ".numbers"
]);
var IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
  ".webp",
  ".svg"
]);
var DOCTOR_COMMAND_NAME = "feynman doctor";
var DOCTOR_COMMAND = `/${DOCTOR_COMMAND_NAME}`;

// vendor/docparser/native-executor.ts
class NativeExecutionError extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = "NativeExecutionError";
  }
}

class NativeCancellationError extends NativeExecutionError {
  constructor(message = "Native document operation was cancelled.") {
    super("cancelled", message);
    this.name = "NativeCancellationError";
  }
}

class NativeTimeoutError extends NativeExecutionError {
  constructor(timeoutMs) {
    super("timeout", `Native document operation timed out after ${timeoutMs}ms.`);
    this.name = "NativeTimeoutError";
  }
}

class NativeCrashError extends NativeExecutionError {
  constructor(message) {
    super("crash", message);
    this.name = "NativeCrashError";
  }
}

class NativeProtocolError extends NativeExecutionError {
  constructor(message, options) {
    super("protocol", message, options);
    this.name = "NativeProtocolError";
  }
}

class NativeOperationError extends NativeExecutionError {
  constructor(message) {
    super("ordinary", message);
    this.name = "NativeOperationError";
  }
}

class NativeDisposedError extends NativeExecutionError {
  constructor(message = "Native document executor is disposed.") {
    super("disposed", message);
    this.name = "NativeDisposedError";
  }
}
var TERMINATION_GRACE_MS = 2000;
var TEARDOWN_LIMIT_MS = 5000;
var POLL_MS = 40;
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function stderrSuffix(stderr) {
  const text = stderr.toString("utf8").trim();
  return text ? ` Worker stderr: ${text}` : "";
}
function appendTail(current, chunk) {
  if (chunk.byteLength >= STDERR_TAIL_MAX_BYTES)
    return chunk.subarray(chunk.byteLength - STDERR_TAIL_MAX_BYTES);
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= STDERR_TAIL_MAX_BYTES ? combined : combined.subarray(combined.byteLength - STDERR_TAIL_MAX_BYTES);
}
function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && ("code" in error) && error.code === "ESRCH");
  }
}
async function waitUntil(predicate, deadline) {
  while (Date.now() < deadline) {
    if (predicate())
      return true;
    await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return predicate();
}
async function terminatePosixTree(child, closeState) {
  const pid = child.pid;
  if (!pid)
    return closeState.closed;
  const started = Date.now();
  const graceDeadline = started + TERMINATION_GRACE_MS;
  const finalDeadline = started + TEARDOWN_LIMIT_MS;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {}
  }
  await waitUntil(() => !isProcessGroupAlive(pid), graceDeadline);
  if (isProcessGroupAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {}
    }
  }
  return waitUntil(() => closeState.closed && !isProcessGroupAlive(pid), finalDeadline);
}
async function terminateWindowsTree(child, closeState) {
  const pid = child.pid;
  if (!pid)
    return closeState.closed;
  let taskkillClosed = true;
  if (!closeState.closed && child.exitCode === null && child.signalCode === null) {
    taskkillClosed = false;
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.once("close", () => {
      taskkillClosed = true;
    });
    killer.once("error", () => {
      taskkillClosed = true;
    });
  }
  const deadline = Date.now() + TEARDOWN_LIMIT_MS;
  return waitUntil(() => closeState.closed && taskkillClosed, deadline);
}
function sanitizedExecArgv() {
  return [];
}

class NativeExecutorImpl {
  workerUrl;
  timeoutMs;
  queue = [];
  active;
  disposed = false;
  poisoned = false;
  disposePromise;
  settleActive;
  constructor(options = {}) {
    this.workerUrl = options.workerUrl ?? new URL("./native-worker.mjs", import.meta.url);
    this.timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("Native worker timeout must be a positive integer.");
    }
  }
  execute(job, options = {}) {
    if (this.disposed)
      return Promise.reject(new NativeDisposedError(this.poisoned ? "Native document executor is poisoned and disposed." : undefined));
    if (options.signal?.aborted)
      return Promise.reject(new NativeCancellationError);
    return new Promise((resolve, reject) => {
      const entry = { job, signal: options.signal, resolve, reject };
      if (entry.signal) {
        entry.queuedAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0)
            return;
          this.queue.splice(index, 1);
          entry.signal?.removeEventListener("abort", entry.queuedAbort);
          reject(new NativeCancellationError);
        };
        entry.signal.addEventListener("abort", entry.queuedAbort, { once: true });
      }
      this.queue.push(entry);
      this.pump();
    });
  }
  async dispose() {
    if (this.disposePromise)
      return this.disposePromise;
    this.disposed = true;
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      if (entry.queuedAbort)
        entry.signal?.removeEventListener("abort", entry.queuedAbort);
      entry.reject(new NativeDisposedError);
    }
    this.disposePromise = (async () => {
      if (!this.active)
        return;
      const settled = new Promise((resolve) => {
        this.settleActive = resolve;
      });
      const cancellation = new NativeDisposedError("Native document operation was stopped because the executor was disposed.");
      if (this.active.cancelActive)
        this.active.cancelActive(cancellation);
      else
        this.active.activeCancellation = cancellation;
      await settled;
    })();
    return this.disposePromise;
  }
  poison() {
    this.poisoned = true;
    this.disposed = true;
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      if (entry.queuedAbort)
        entry.signal?.removeEventListener("abort", entry.queuedAbort);
      entry.reject(new NativeDisposedError("Native document executor was poisoned by uncertain process teardown."));
    }
  }
  pump() {
    if (this.active || this.disposed)
      return;
    const entry = this.queue.shift();
    if (!entry)
      return;
    if (entry.queuedAbort)
      entry.signal?.removeEventListener("abort", entry.queuedAbort);
    this.active = entry;
    this.runEntry(entry);
  }
  async runEntry(entry) {
    let result;
    let failure;
    try {
      result = await this.runChild(entry);
    } catch (error) {
      failure = error;
    }
    if (!this.poisoned && entry.ownsStaging) {
      await rm(entry.job.stagingDir, { recursive: true, force: true }).catch(() => {
        return;
      });
    }
    if (failure === undefined)
      entry.resolve(result);
    else
      entry.reject(failure);
    this.active = undefined;
    this.settleActive?.();
    this.settleActive = undefined;
    this.pump();
  }
  async runChild(entry) {
    const timeoutDeadline = Date.now() + this.timeoutMs;
    if (entry.signal?.aborted)
      throw new NativeCancellationError;
    const requestWithOptionals = {
      version: PROTOCOL_VERSION,
      jobId: randomUUID(),
      ...entry.job
    };
    const wireRequest = JSON.parse(JSON.stringify(requestWithOptionals));
    try {
      validateWorkerRequest(wireRequest);
    } catch (error) {
      throw new NativeProtocolError(`Invalid native worker request: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    let requestFrame;
    try {
      requestFrame = encodeFrame(wireRequest, REQUEST_MAX_BYTES, "Request");
    } catch (error) {
      throw new NativeProtocolError(error instanceof Error ? error.message : String(error), {
        cause: error
      });
    }
    if (entry.signal?.aborted)
      throw new NativeCancellationError;
    if (Date.now() >= timeoutDeadline)
      throw new NativeTimeoutError(this.timeoutMs);
    try {
      await mkdir(entry.job.stagingDir, { recursive: false });
      entry.ownsStaging = true;
      await writeFile(join(entry.job.stagingDir, ".native-job-owner"), String(wireRequest.jobId), {
        flag: "wx"
      });
    } catch (error) {
      if (entry.activeCancellation)
        throw entry.activeCancellation;
      throw new NativeOperationError(`Could not create the native job staging directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (entry.activeCancellation)
      throw entry.activeCancellation;
    if (entry.signal?.aborted)
      throw new NativeCancellationError;
    if (Date.now() >= timeoutDeadline)
      throw new NativeTimeoutError(this.timeoutMs);
    const workerPath = this.workerUrl instanceof URL ? fileURLToPath(this.workerUrl) : this.workerUrl;
    const closeState = { closed: false };
    let closeCode = null;
    let closeSignal = null;
    let exited = false;
    let stderr = Buffer.alloc(0);
    let terminalError;
    let teardownPromise;
    let responseError;
    const child = spawn(process.execPath, [...sanitizedExecArgv(), workerPath], {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let resolveTeardownCompletion;
    const teardownCompletion = new Promise((resolve) => {
      resolveTeardownCompletion = resolve;
    });
    const trigger = (error, terminate) => {
      if (terminalError)
        return;
      if (closeState.closed && (error.code === "cancelled" || error.code === "timeout" || error.code === "disposed"))
        return;
      terminalError = error;
      if (terminate) {
        teardownPromise = process.platform === "win32" ? terminateWindowsTree(child, closeState) : terminatePosixTree(child, closeState);
        teardownPromise.then(resolveTeardownCompletion, () => resolveTeardownCompletion(false));
      }
    };
    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        exited = true;
        closeCode = code;
        closeSignal = signal;
        if (code !== 0 || signal) {
          trigger(new NativeCrashError(`Native worker crashed${signal ? ` from signal ${signal}` : ` with exit code ${code}`}.`), true);
        }
        resolve();
      });
    });
    const closePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        closeState.closed = true;
        closeCode = code;
        closeSignal = signal;
        resolve();
      });
    });
    child.once("error", (error) => {
      trigger(new NativeCrashError(`Failed to launch native worker: ${error.message}`), false);
    });
    child.stdout?.resume();
    child.stderr?.on("data", (chunk) => {
      stderr = appendTail(stderr, Buffer.from(chunk));
    });
    const responsePipe = child.stdio[4];
    const requestPipe = child.stdio[3];
    if (!responsePipe || typeof responsePipe === "number" || !(Symbol.asyncIterator in responsePipe)) {
      trigger(new NativeProtocolError("Native worker response pipe is unavailable."), true);
    }
    const responsePromise = responsePipe && typeof responsePipe !== "number" && Symbol.asyncIterator in responsePipe ? readSingleFrame(responsePipe, RESPONSE_MAX_BYTES, "Response").then((value) => {
      try {
        return validateWorkerResponse(value, wireRequest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new NativeProtocolError(`Invalid native worker response: ${message}`, {
          cause: error
        });
      }
    }).catch(async (error) => {
      responseError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ended before") && !exited) {
        await Promise.race([exitPromise, delay(20)]);
      }
      if (error instanceof NativeProtocolError || !message.includes("ended before") || !exited) {
        trigger(error instanceof NativeProtocolError ? error : new NativeProtocolError(`Invalid native worker response: ${message}`, {
          cause: error
        }), true);
      }
      return;
    }) : Promise.resolve(undefined);
    if (!requestPipe || typeof requestPipe === "number" || !("end" in requestPipe)) {
      trigger(new NativeProtocolError("Native worker request pipe is unavailable."), true);
    } else {
      requestPipe.end(requestFrame, (error) => {
        if (error)
          trigger(new NativeProtocolError(`Failed to send native worker request: ${error.message}`, {
            cause: error
          }), true);
      });
    }
    const timeout = setTimeout(() => {
      trigger(new NativeTimeoutError(this.timeoutMs), true);
    }, Math.max(1, timeoutDeadline - Date.now()));
    const onAbort = () => trigger(new NativeCancellationError, true);
    entry.cancelActive = (error) => trigger(error, true);
    if (entry.activeCancellation)
      trigger(entry.activeCancellation, true);
    entry.signal?.addEventListener("abort", onAbort, { once: true });
    if (entry.signal?.aborted)
      onAbort();
    const completed = Promise.all([closePromise, responsePromise]).then(([, response2]) => ({
      kind: "completed",
      response: response2
    }));
    let response;
    try {
      const first = await Promise.race([
        completed,
        teardownCompletion.then((certain) => ({ kind: "teardown", certain }))
      ]);
      if (first.kind === "teardown") {
        if (!first.certain) {
          this.poison();
          throw new NativeDisposedError(`${terminalError?.message ?? "Native worker failed."} Process-tree teardown remained uncertain after ${TEARDOWN_LIMIT_MS}ms; the executor was poisoned.`);
        }
        response = (await completed).response;
      } else {
        response = first.response;
        if (teardownPromise && !await teardownPromise) {
          this.poison();
          throw new NativeDisposedError(`${terminalError?.message ?? "Native worker failed."} Process-tree teardown remained uncertain after ${TEARDOWN_LIMIT_MS}ms; the executor was poisoned.`);
        }
      }
    } finally {
      clearTimeout(timeout);
      entry.signal?.removeEventListener("abort", onAbort);
      entry.cancelActive = undefined;
    }
    if (terminalError) {
      if (terminalError.code === "crash") {
        throw new NativeCrashError(`${terminalError.message}${stderrSuffix(stderr)}`);
      }
      throw terminalError;
    }
    if (response === undefined) {
      if (closeCode !== 0 || closeSignal) {
        throw new NativeCrashError(`Native worker crashed${closeSignal ? ` from signal ${closeSignal}` : ` with exit code ${closeCode}`}.${stderrSuffix(stderr)}`);
      }
      const message = responseError instanceof Error ? responseError.message : String(responseError ?? "missing response");
      throw new NativeProtocolError(`Invalid native worker response: ${message}`);
    }
    const validated = response;
    if (closeCode !== 0 || closeSignal) {
      throw new NativeCrashError(`Native worker crashed${closeSignal ? ` from signal ${closeSignal}` : ` with exit code ${closeCode}`}.${stderrSuffix(stderr)}`);
    }
    if (validated.ok === false) {
      const workerError = validated.error;
      throw new NativeOperationError(workerError.message);
    }
    return validated.result;
  }
}
function createNativeExecutor(options = {}) {
  return new NativeExecutorImpl(options);
}
function formatNativeExecutionError(error, fallback) {
  if (!(error instanceof NativeExecutionError)) {
    const message = error instanceof Error ? error.message : String(error);
    return message || fallback;
  }
  if (error.code === "cancelled")
    return `Document operation was cancelled. ${error.message}`;
  if (error.code === "timeout")
    return `Document operation timed out. ${error.message}`;
  if (error.code === "crash")
    return `Native document worker crashed. ${error.message}`;
  if (error.code === "protocol")
    return `Native document worker protocol error. ${error.message}`;
  return error.message || fallback;
}
// vendor/docparser/pi-shim.js
import { Type as Type4 } from "typebox";
var StringEnum = (values, options = {}) => Type4.Unsafe({ type: "string", enum: values, ...options });
function truncate(text, options, tail) {
  const lines = text.split(`
`);
  let content = (tail ? lines.slice(-options.maxLines) : lines.slice(0, options.maxLines)).join(`
`);
  const chars = [...content];
  let bytes = 0;
  let length = 0;
  for (const char of tail ? chars.slice().reverse() : chars) {
    const next = Buffer.byteLength(char);
    if (bytes + next > options.maxBytes)
      break;
    bytes += next;
    length += 1;
  }
  content = (tail ? chars.slice(chars.length - length) : chars.slice(0, length)).join("");
  return { content, truncated: content !== text };
}
var truncateHead = (text, options) => truncate(text, options, false);

// vendor/docparser/tool.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdtemp, open as open2, rm as rm2, stat as stat2 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// vendor/docparser/deps.ts
import { spawn as spawn2 } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
var DEPENDENCY_NAMES = ["libreoffice"];
var PACKAGE_NAMES = {
  brew: { libreoffice: "libreoffice" },
  "apt-get": { libreoffice: "libreoffice" },
  dnf: { libreoffice: "libreoffice" },
  yum: { libreoffice: "libreoffice" },
  pacman: { libreoffice: "libreoffice-fresh" },
  zypper: { libreoffice: "libreoffice" },
  apk: { libreoffice: "libreoffice" },
  winget: { libreoffice: "TheDocumentFoundation.LibreOffice" },
  choco: { libreoffice: "libreoffice-fresh" }
};
var BREW_CASK_DEPENDENCIES = new Set(["libreoffice"]);
var DEPENDENCY_SETUP_PATTERNS = ["LibreOffice is not installed"];
async function spawnSucceeded(command, args) {
  return new Promise((resolve) => {
    const child = spawn2(command, args, {
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
async function runBinaryLookup(binary) {
  return spawnSucceeded(process.platform === "win32" ? "where" : "which", [binary]);
}
async function isExecutablePathAvailable(filePath) {
  try {
    await access(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function findFirstAvailableCommand(commandNames, candidatePaths = []) {
  for (const commandName of commandNames) {
    if (await runBinaryLookup(commandName)) {
      return commandName;
    }
  }
  for (const candidatePath of candidatePaths) {
    if (await isExecutablePathAvailable(candidatePath)) {
      return candidatePath;
    }
  }
  return;
}
function buildCommandDisplay(command, args, displayPrefix = "") {
  return `${displayPrefix}${command}${args.length > 0 ? ` ${args.join(" ")}` : ""}`;
}
function createDisplayCommand(manager, dependencyName) {
  if (manager === "brew" && BREW_CASK_DEPENDENCIES.has(dependencyName)) {
    return buildCommandDisplay("brew", ["install", "--cask", PACKAGE_NAMES.brew[dependencyName]]);
  }
  if (manager === "choco") {
    return buildCommandDisplay("choco", ["install", PACKAGE_NAMES.choco[dependencyName]]);
  }
  return buildCommandDisplay(manager, ["install", PACKAGE_NAMES[manager][dependencyName]]);
}
function buildGuidedInstallMessage(dependencyName, summary, options = {}) {
  const macCommand = createDisplayCommand("brew", dependencyName);
  const ubuntuCommand = createDisplayCommand("apt-get", dependencyName);
  const windowsCommand = createDisplayCommand("choco", dependencyName);
  const requirement = options.requiredForFileType ? ` to convert ${options.requiredForFileType} files` : "";
  return `${summary}${requirement}. On macOS: ${macCommand}, On Ubuntu: ${ubuntuCommand}, On Windows: ${windowsCommand}`;
}
var DEPENDENCY_METADATA = {
  libreoffice: {
    label: "LibreOffice",
    summary: "Needed for Office documents and spreadsheets such as DOCX, PPTX, XLSX, CSV, and similar formats.",
    findCommand: () => findFirstAvailableCommand(["libreoffice", "soffice"], process.platform === "darwin" ? [
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      "/Applications/LibreOffice.app/Contents/MacOS/libreoffice"
    ] : process.platform === "win32" ? [
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files\\LibreOffice\\program\\libreoffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\libreoffice.exe"
    ] : []),
    getMissingMessage: () => buildGuidedInstallMessage("libreoffice", "LibreOffice is not installed. Please install LibreOffice to convert office documents")
  }
};
function getRelevantDependencyNames(inspection) {
  if (!inspection) {
    return new Set(DEPENDENCY_NAMES);
  }
  return inspection.category === "office" || inspection.category === "spreadsheet" ? new Set(["libreoffice"]) : new Set;
}
async function diagnoseDependencies(inspection) {
  const relevantDependencies = getRelevantDependencyNames(inspection);
  const detectedCommands = await Promise.all(DEPENDENCY_NAMES.map((dependencyName) => DEPENDENCY_METADATA[dependencyName].findCommand()));
  return DEPENDENCY_NAMES.map((dependencyName, index) => ({
    name: dependencyName,
    label: DEPENDENCY_METADATA[dependencyName].label,
    installed: Boolean(detectedCommands[index]),
    detectedCommand: detectedCommands[index],
    relevant: relevantDependencies.has(dependencyName),
    summary: DEPENDENCY_METADATA[dependencyName].summary,
    missingMessage: DEPENDENCY_METADATA[dependencyName].getMissingMessage(inspection)
  }));
}
async function getMissingHostDependencyMessage(inspection) {
  const diagnoses = await diagnoseDependencies(inspection);
  return diagnoses.find((diagnosis) => diagnosis.relevant && !diagnosis.installed)?.missingMessage;
}
function isDependencySetupMessage(message) {
  return DEPENDENCY_SETUP_PATTERNS.some((pattern) => message.includes(pattern));
}
function appendDoctorHint(message) {
  return message.includes(DOCTOR_COMMAND) ? message : `${message} Run ${DOCTOR_COMMAND} for guided setup.`;
}

// vendor/docparser/input.ts
import { constants as fsConstants2 } from "node:fs";
import { access as access2, open, stat } from "node:fs/promises";
import { extname, isAbsolute as isAbsolute2, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
var UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
var NARROW_NO_BREAK_SPACE = " ";
function normalizeDocumentPathInput(input) {
  return input.trim().replace(/^@/, "").replace(UNICODE_SPACES, " ");
}
function expandHomeDirectory(filePath) {
  if (filePath === "~") {
    return homedir();
  }
  if (filePath.startsWith("~/")) {
    return `${homedir()}${filePath.slice(1)}`;
  }
  return filePath;
}
function tryMacOsAmPmVariant(filePath) {
  return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}
function tryNfdVariant(filePath) {
  return filePath.normalize("NFD");
}
function tryCurlyQuoteVariant(filePath) {
  return filePath.replace(/'/g, "’");
}
async function pathExists(filePath) {
  try {
    await access2(filePath, fsConstants2.F_OK);
    return true;
  } catch {
    return false;
  }
}
async function resolveExistingPath(filePath, cwd) {
  const expanded = expandHomeDirectory(filePath);
  const resolved = isAbsolute2(expanded) ? expanded : resolvePath(cwd, expanded);
  const nfdVariant = tryNfdVariant(resolved);
  for (const candidate of new Set([
    resolved,
    tryMacOsAmPmVariant(resolved),
    nfdVariant,
    tryCurlyQuoteVariant(resolved),
    tryCurlyQuoteVariant(nfdVariant)
  ])) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return resolved;
}
async function ensureReadableFile(filePath, sourcePath) {
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      throw new Error("not a regular file");
    }
    await access2(filePath, fsConstants2.R_OK);
  } catch {
    throw new Error(`Document file not found, not readable, or not a regular file: ${sourcePath}`);
  }
}
function getInputCategory(extension) {
  if (extension === ".pdf") {
    return "pdf";
  }
  if (OFFICE_EXTENSIONS.has(extension)) {
    return "office";
  }
  if (SPREADSHEET_EXTENSIONS.has(extension)) {
    return "spreadsheet";
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  return;
}
async function readFileHeader(filePath, length) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
function isPdfHeader(header) {
  return header.length >= 4 && header.toString("utf8", 0, 4) === "%PDF";
}
function isPngHeader(header) {
  return header.length >= 4 && header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71;
}
function isJpegHeader(header) {
  return header.length >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255;
}
async function inspectInputFile(filePath) {
  const extension = extname(filePath).toLowerCase();
  const category = getInputCategory(extension);
  if (category) {
    return { extension, category };
  }
  try {
    const header = await readFileHeader(filePath, 16);
    if (isPdfHeader(header)) {
      return { extension: extension || ".pdf", category: "pdf" };
    }
    if (!extension && isPngHeader(header)) {
      return { extension: ".png", category: "image" };
    }
    if (!extension && isJpegHeader(header)) {
      return { extension: ".jpg", category: "image" };
    }
  } catch {}
  return { extension, category: "other" };
}
async function resolveDocumentTarget(input, cwd) {
  const sourcePath = normalizeDocumentPathInput(input);
  const resolvedPath = await resolveExistingPath(sourcePath, cwd);
  await ensureReadableFile(resolvedPath, sourcePath);
  return {
    sourcePath,
    resolvedPath,
    inspection: await inspectInputFile(resolvedPath)
  };
}
function parsePageNumber(value, token) {
  const normalized = value.replace(/^0+/, "") || "0";
  const maximum = String(MAX_PAGE_NUMBER);
  if (normalized === "0" || normalized.length > maximum.length || normalized.length === maximum.length && normalized > maximum) {
    throw new Error(`Page number must be between 1 and ${MAX_PAGE_NUMBER}: ${token}`);
  }
  return Number(normalized);
}
function parsePageSelection(selection, maxPageCount = MAX_PAGE_SELECTION_EXPANSION) {
  const byteLength = Buffer.byteLength(selection, "utf8");
  if (byteLength > MAX_PAGE_SELECTION_BYTES) {
    throw new Error(`Page selection exceeds the ${MAX_PAGE_SELECTION_BYTES}-byte UTF-8 limit.`);
  }
  if (!Number.isInteger(maxPageCount) || maxPageCount < 1 || maxPageCount > MAX_PAGE_SELECTION_EXPANSION) {
    throw new Error(`Page count limit must be an integer between 1 and ${MAX_PAGE_SELECTION_EXPANSION}.`);
  }
  const tokens = selection.split(",");
  if (tokens.length > MAX_PAGE_SELECTION_TOKENS) {
    throw new Error(`Page selection exceeds the ${MAX_PAGE_SELECTION_TOKENS}-token limit.`);
  }
  const pages = new Set;
  let expansionWork = 0;
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) {
      throw new Error("Page selection contains an empty token.");
    }
    const singleMatch = /^(\d+)$/.exec(token);
    if (singleMatch) {
      expansionWork += 1;
      if (expansionWork > MAX_PAGE_SELECTION_EXPANSION) {
        throw new Error(`Page selection exceeds the ${MAX_PAGE_SELECTION_EXPANSION}-page expansion limit.`);
      }
      pages.add(parsePageNumber(singleMatch[1], token));
      continue;
    }
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (!rangeMatch) {
      throw new Error(`Invalid page selection token: ${token}`);
    }
    const start = parsePageNumber(rangeMatch[1], token);
    const end = parsePageNumber(rangeMatch[2], token);
    if (end < start) {
      throw new Error(`Page range must be ascending: ${token}`);
    }
    const rangeLength = end - start + 1;
    if (rangeLength > MAX_PAGE_SELECTION_EXPANSION - expansionWork) {
      throw new Error(`Page selection exceeds the ${MAX_PAGE_SELECTION_EXPANSION}-page expansion limit.`);
    }
    expansionWork += rangeLength;
    for (let page = start;page <= end; page += 1) {
      pages.add(page);
    }
  }
  const result = Array.from(pages).sort((a, b) => a - b);
  if (result.length > maxPageCount) {
    throw new Error(`Page selection contains more than ${maxPageCount} selected pages.`);
  }
  return result;
}
function validateSearchPhrase(phrase) {
  if (!phrase.trim()) {
    throw new Error("Search phrase must not be blank.");
  }
  if (Buffer.byteLength(phrase, "utf8") > MAX_SEARCH_PHRASE_BYTES) {
    throw new Error(`Search phrase exceeds the ${MAX_SEARCH_PHRASE_BYTES}-byte UTF-8 limit.`);
  }
}
function resolveScreenshotSelection(selection) {
  if (selection === undefined) {
    return { pageNumbers: [1], description: "page 1" };
  }
  const trimmedSelection = selection.trim();
  if (!trimmedSelection) {
    throw new Error("Screenshot page selection must not be empty.");
  }
  if (["all", "*"].includes(trimmedSelection.toLowerCase())) {
    throw new Error(`Screenshot requests must name at most ${MAX_SCREENSHOT_PAGES} explicit pages; make bounded repeated calls instead of using "all" or "*".`);
  }
  const pageNumbers = parsePageSelection(trimmedSelection, MAX_SCREENSHOT_PAGES);
  return {
    pageNumbers,
    description: `pages ${pageNumbers.join(", ")}`
  };
}

// vendor/docparser/liteparse-config.ts
var REMOVED_V1_OPTIONS = [
  "preciseBoundingBox",
  "preserveLayoutAlignmentAcrossPages"
];
function getRemovedV1OptionsMessage(optionNames) {
  const options = optionNames.map((name) => `\`${name}\``).join(", ");
  return [
    `Unsupported LiteParse v1 option${optionNames.length === 1 ? "" : "s"}: ${options}.`,
    "This package now uses LiteParse v2, which no longer exposes those options.",
    "Alternative routes for agents: use JSON output for text item bounding boxes, use document_search to locate phrases with bounding boxes, use document_screenshot for visual layout checks, or narrow work with targetPages."
  ].join(" ");
}
function getProvidedRemovedV1Options(rawParams) {
  if (!rawParams || typeof rawParams !== "object") {
    return [];
  }
  return REMOVED_V1_OPTIONS.filter((optionName) => (optionName in rawParams));
}
function normalizeOptionalString(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
function validateIntegerRange(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}
function resolveOcrLanguage(params, ocrServerUrl, warnings) {
  const singleOcrLanguage = normalizeOptionalString(params.ocrLanguage);
  const ocrLanguages = (params.ocrLanguages ?? []).map((language) => language.trim()).filter(Boolean);
  if (singleOcrLanguage && ocrLanguages.length > 0) {
    warnings.push("Both ocrLanguage and ocrLanguages were provided. Using ocrLanguages.");
  }
  if (ocrLanguages.length === 0) {
    return singleOcrLanguage;
  }
  if (ocrServerUrl) {
    if (ocrLanguages.length > 1) {
      warnings.push("Multiple OCR languages were provided, but HTTP OCR servers currently receive only the first language code.");
    }
    return ocrLanguages[0];
  }
  return ocrLanguages.join("+");
}
function buildLiteParseConfig(params, warnings) {
  const ocrServerUrl = normalizeOptionalString(params.ocrServerUrl);
  const ocrLanguage = resolveOcrLanguage(params, ocrServerUrl, warnings);
  const numWorkers = params.numWorkers ?? DEFAULT_NUM_WORKERS;
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
  const dpi = params.dpi ?? DEFAULT_DPI;
  validateIntegerRange("numWorkers", numWorkers, 1, MAX_NUM_WORKERS);
  validateIntegerRange("maxPages", maxPages, 1, MAX_PAGES);
  validateIntegerRange("dpi", dpi, MIN_DPI, MAX_DPI);
  const normalizedTargetPages = params.targetPages === undefined ? undefined : parsePageSelection(params.targetPages, maxPages).join(",");
  return {
    outputFormat: params.format ?? "text",
    ocrEnabled: (params.ocr ?? "auto") !== "off",
    ocrLanguage,
    ocrServerUrl,
    numWorkers,
    maxPages,
    targetPages: normalizedTargetPages,
    dpi,
    preserveVerySmallText: params.preserveSmallText ?? false,
    password: normalizeOptionalString(params.password),
    tessdataPath: normalizeOptionalString(params.tessdataPath),
    quiet: true
  };
}
function buildDocumentParsePlan(params) {
  const warnings = [];
  const parserConfig = buildLiteParseConfig(params, warnings);
  return {
    parserConfig,
    screenshotSelection: params.screenshotPages !== undefined ? resolveScreenshotSelection(params.screenshotPages) : undefined,
    warnings
  };
}

// vendor/docparser/schema.ts
import { Type as Type5 } from "typebox";
var DocumentParseSchema = Type5.Object({
  path: Type5.String({
    description: "Path to the document file to parse (PDF, DOCX, PPTX, XLSX, CSV, PNG, JPG, TIFF, WebP, etc.)"
  }),
  format: Type5.Optional(StringEnum(["text", "json"], {
    description: "Output format for the parsed document (default: text)"
  })),
  targetPages: Type5.Optional(Type5.String({
    maxLength: MAX_PAGE_SELECTION_BYTES,
    description: 'Optional page selection for parsing, e.g. "1-5,10,15-20"'
  })),
  screenshotPages: Type5.Optional(Type5.String({
    maxLength: MAX_PAGE_SELECTION_BYTES,
    description: `Optional explicit page selection for screenshots, e.g. "1-3,8" (maximum ${MAX_SCREENSHOT_PAGES} pages). Screenshots are saved as PNG files.`
  })),
  ocr: Type5.Optional(StringEnum(["auto", "off"], {
    description: "OCR mode: auto uses LiteParse OCR behavior, off disables OCR for faster parsing"
  })),
  ocrLanguage: Type5.Optional(Type5.String({
    description: "Optional single OCR language code. Built-in Tesseract typically uses ISO 639-3 codes such as eng, deu, fra, jpn. Many HTTP OCR servers instead expect ISO 639-1 codes such as en, de, fr, ja."
  })),
  ocrLanguages: Type5.Optional(Type5.Array(Type5.String(), {
    minItems: 1,
    description: "Optional multiple OCR language codes. For built-in Tesseract they are joined into a multilingual language string. For HTTP OCR servers, only the first code is forwarded."
  })),
  ocrServerUrl: Type5.Optional(Type5.String({
    description: "Optional HTTP OCR server URL implementing the LiteParse OCR API"
  })),
  numWorkers: Type5.Optional(Type5.Integer({
    minimum: 1,
    maximum: MAX_NUM_WORKERS,
    description: `Optional OCR worker count (default: ${DEFAULT_NUM_WORKERS}, maximum: ${MAX_NUM_WORKERS})`
  })),
  maxPages: Type5.Optional(Type5.Integer({
    minimum: 1,
    maximum: MAX_PAGES,
    description: `Maximum number of pages to parse (default: ${DEFAULT_MAX_PAGES}, maximum: ${MAX_PAGES})`
  })),
  dpi: Type5.Optional(Type5.Integer({
    minimum: MIN_DPI,
    maximum: MAX_DPI,
    description: `Rendering DPI for OCR and screenshots (default: ${DEFAULT_DPI})`
  })),
  preserveSmallText: Type5.Optional(Type5.Boolean({
    description: "Whether to preserve very small text that would otherwise be filtered out"
  })),
  password: Type5.Optional(Type5.String({
    description: "Optional password for encrypted or password-protected documents"
  })),
  tessdataPath: Type5.Optional(Type5.String({
    description: "Optional path to a directory containing Tesseract .traineddata files for offline/custom OCR data"
  }))
});

// vendor/docparser/tool.ts
function buildFriendlyErrorMessage(error, stage = "parse") {
  const message = error instanceof NativeExecutionError ? formatNativeExecutionError(error, "Document parsing failed.") : error instanceof Error ? error.message : String(error);
  if (isDependencySetupMessage(message))
    return appendDoctorHint(message);
  if (stage === "screenshot") {
    return message.startsWith("Screenshot generation failed:") ? message : `Screenshot generation failed: ${message}`;
  }
  return message || "Document parsing failed.";
}
async function readPreview(outputPath) {
  const fileStats = await stat2(outputPath);
  const handle = await open2(outputPath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(PREVIEW_MAX_BYTES, fileStats.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const truncation = truncateHead(text, {
      maxLines: PREVIEW_MAX_LINES,
      maxBytes: PREVIEW_MAX_BYTES
    });
    return {
      preview: truncation.content.trim(),
      truncated: truncation.truncated || fileStats.size > bytesRead
    };
  } finally {
    await handle.close();
  }
}
async function renderScreenshots(options) {
  const warnings = [];
  const selection = options.screenshotSelection;
  if (!selection)
    return { screenshotCount: 0, warnings };
  if (options.signal?.aborted) {
    warnings.push("Operation was aborted before screenshot rendering. Parsed output was still saved.");
    return { screenshotCount: 0, warnings };
  }
  try {
    options.emit(`Rendering screenshots for ${selection.description}...`);
    const screenshotDir = join2(options.outputDir, "screenshots");
    const result = await options.executor.execute({
      operation: "screenshot",
      inputPath: options.resolvedPath,
      stagingDir: join2(options.outputDir, `.screenshot-${randomUUID2()}`),
      outputDir: screenshotDir,
      pages: selection.pageNumbers,
      dpi: options.dpi,
      password: options.password
    }, { signal: options.signal });
    options.emit(`Saved ${result.screenshots.length} screenshot${result.screenshots.length === 1 ? "" : "s"} to ${result.screenshotDir}`);
    return {
      screenshotCount: result.screenshots.length,
      screenshotDir: result.screenshotDir,
      screenshotPathsPreview: result.screenshots.map((item) => item.outputPath).slice(0, 4),
      warnings
    };
  } catch (error) {
    warnings.push(buildFriendlyErrorMessage(error, "screenshot"));
    return { screenshotCount: 0, warnings };
  }
}
function buildSummary(options) {
  const lines = [
    `Parsed document: ${options.sourcePath}`,
    `Resolved path: ${options.resolvedPath}`,
    `Output format: ${options.outputFormat}`,
    `Pages parsed: ${options.pageCount}`,
    `Parsed output saved to: ${options.outputPath}`
  ];
  if (options.screenshotDir) {
    lines.push(`Screenshots saved to: ${options.screenshotDir}`);
    lines.push(`Screenshot count: ${options.screenshotCount}`);
    if (options.screenshotPathsPreview?.length) {
      lines.push("Screenshot files:");
      for (const screenshotPath of options.screenshotPathsPreview)
        lines.push(`- ${screenshotPath}`);
    }
  }
  if (options.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of options.warnings)
      lines.push(`- ${warning}`);
  }
  if (options.preview.length > 0) {
    lines.push("Preview:", options.preview);
    if (options.truncated) {
      lines.push("", `Preview truncated. Use read on ${options.outputPath} for the full parsed output.`);
    }
  }
  return lines.join(`
`);
}
function registerDocumentParseTool(pi, executor) {
  pi.registerTool({
    name: "document_parse",
    label: "Document Parse",
    description: "Parse local documents with bundled LiteParse v2 support. Supports PDF, DOCX, PPTX, XLSX, CSV, and common images. Returns bounded projected text or JSON saved to temp files plus metadata and optional screenshots.",
    promptSnippet: "Parse local documents to text or stable projected JSON with OCR, bounding boxes, page ranges, password support, offline OCR data, and optional screenshots.",
    promptGuidelines: [
      "Use this tool instead of composing LiteParse CLI commands manually when the user wants local document parsing.",
      "After this tool returns output or screenshot paths, use read on those files when you need the full parsed content or to inspect generated screenshots.",
      "Do not use removed LiteParse v1 options preciseBoundingBox or preserveLayoutAlignmentAcrossPages. Use JSON bounding boxes, document_search, document_screenshot, or targetPages instead."
    ],
    parameters: DocumentParseSchema,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            { type: "text", text: "Document parsing was cancelled before it started." }
          ],
          details: {}
        };
      }
      const emit = (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} });
      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0)
        throw new Error(getRemovedV1OptionsMessage(removedOptions));
      const params = rawParams;
      let outputDir;
      let parseCompleted = false;
      try {
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const plan = buildDocumentParsePlan(params);
        const warnings = [...plan.warnings];
        emit("Checking host dependencies...");
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(input.inspection);
        if (missingHostDependencyMessage)
          throw new Error(missingHostDependencyMessage);
        outputDir = await mkdtemp(join2(tmpdir(), "pi-document-parse-"));
        const outputFormat = plan.parserConfig.outputFormat;
        const outputPath = join2(outputDir, outputFormat === "json" ? "parsed.json" : "parsed.txt");
        emit(`Parsing document: ${input.sourcePath}`);
        const parseResult = await executor.execute({
          operation: "parse",
          inputPath: input.resolvedPath,
          stagingDir: join2(outputDir, `.parse-${randomUUID2()}`),
          outputPath,
          config: plan.parserConfig
        }, { signal });
        parseCompleted = true;
        emit(`Saved parsed output to ${outputPath}`);
        const screenshotResult = await renderScreenshots({
          executor,
          screenshotSelection: plan.screenshotSelection,
          resolvedPath: input.resolvedPath,
          outputDir,
          dpi: plan.parserConfig.dpi,
          password: plan.parserConfig.password,
          signal,
          emit
        });
        warnings.push(...screenshotResult.warnings);
        const { preview, truncated } = await readPreview(outputPath);
        const content = buildSummary({
          sourcePath: input.sourcePath,
          resolvedPath: input.resolvedPath,
          outputFormat,
          outputPath,
          pageCount: parseResult.pageCount,
          screenshotCount: screenshotResult.screenshotCount,
          screenshotDir: screenshotResult.screenshotDir,
          screenshotPathsPreview: screenshotResult.screenshotPathsPreview,
          warnings,
          preview,
          truncated
        });
        const details = {
          sourcePath: input.sourcePath,
          resolvedPath: input.resolvedPath,
          outputFormat,
          outputPath,
          outputDir,
          pageCount: parseResult.pageCount,
          screenshotCount: screenshotResult.screenshotCount,
          screenshotDir: screenshotResult.screenshotDir,
          screenshotPathsPreview: screenshotResult.screenshotPathsPreview,
          warnings: warnings.length > 0 ? warnings : undefined
        };
        return { content: [{ type: "text", text: content }], details };
      } catch (error) {
        if (outputDir && !parseCompleted)
          await rm2(outputDir, { recursive: true, force: true }).catch(() => {
            return;
          });
        throw new Error(buildFriendlyErrorMessage(error));
      }
    }
  });
}
// vendor/docparser/search-tool.ts
import { Type as Type6 } from "typebox";
import { randomUUID as randomUUID3 } from "node:crypto";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join3 } from "node:path";
var DocumentSearchSchema = Type6.Object({
  path: Type6.String({ description: "Path to the document file to search" }),
  phrase: Type6.String({
    maxLength: MAX_SEARCH_PHRASE_BYTES,
    description: `Phrase to search for in the parsed document (maximum ${MAX_SEARCH_PHRASE_BYTES} UTF-8 bytes)`
  }),
  caseSensitive: Type6.Optional(Type6.Boolean({
    description: "Whether phrase matching should be case-sensitive (default: false)"
  })),
  targetPages: Type6.Optional(Type6.String({
    maxLength: MAX_PAGE_SELECTION_BYTES,
    description: 'Optional page selection for parsing/searching, e.g. "1-5,10"'
  })),
  ocr: Type6.Optional(StringEnum(["auto", "off"], {
    description: "OCR mode: auto uses LiteParse OCR behavior, off disables OCR for faster parsing"
  })),
  ocrLanguage: Type6.Optional(Type6.String({ description: "Optional single OCR language code, e.g. eng, deu, fra, jpn" })),
  ocrLanguages: Type6.Optional(Type6.Array(Type6.String(), {
    minItems: 1,
    description: "Optional multiple OCR language codes for built-in Tesseract OCR"
  })),
  ocrServerUrl: Type6.Optional(Type6.String({ description: "Optional HTTP OCR server URL implementing the LiteParse OCR API" })),
  numWorkers: Type6.Optional(Type6.Integer({
    minimum: 1,
    maximum: MAX_NUM_WORKERS,
    description: `Optional OCR worker count (default: ${DEFAULT_NUM_WORKERS}, maximum: ${MAX_NUM_WORKERS})`
  })),
  maxPages: Type6.Optional(Type6.Integer({
    minimum: 1,
    maximum: MAX_PAGES,
    description: `Maximum number of pages to search (default: ${DEFAULT_MAX_PAGES}, maximum: ${MAX_PAGES})`
  })),
  dpi: Type6.Optional(Type6.Integer({
    minimum: MIN_DPI,
    maximum: MAX_DPI,
    description: `Rendering DPI for OCR (default: ${DEFAULT_DPI})`
  })),
  password: Type6.Optional(Type6.String({ description: "Optional password for encrypted or password-protected documents" })),
  tessdataPath: Type6.Optional(Type6.String({
    description: "Optional path to Tesseract .traineddata files for offline/custom OCR data"
  })),
  maxResults: Type6.Optional(Type6.Integer({
    minimum: 1,
    maximum: MAX_RESULTS,
    description: `Maximum number of search hits to return (default: ${DEFAULT_MAX_RESULTS}, maximum: ${MAX_RESULTS})`
  }))
});
function formatHit(hit) {
  return `p${hit.pageNum} [${hit.x.toFixed(1)}, ${hit.y.toFixed(1)} ${hit.width.toFixed(1)}×${hit.height.toFixed(1)}] ${hit.text}`;
}
function buildFriendlyErrorMessage2(error) {
  const message = error instanceof NativeExecutionError ? formatNativeExecutionError(error, "Document search failed.") : error instanceof Error ? error.message : String(error);
  return isDependencySetupMessage(message) ? appendDoctorHint(message) : message || "Document search failed.";
}
function registerDocumentSearchTool(pi, executor) {
  pi.registerTool({
    name: "document_search",
    label: "Document Search",
    description: "Search a local document with LiteParse v2 and return bounded projected phrase hits with page numbers and bounding boxes.",
    promptSnippet: "Search parsed documents for a phrase and get page + bounding-box hits for visual citations.",
    promptGuidelines: [
      "Use document_search when the user asks where text appears in a document or needs source/citation locations.",
      "Use targetPages when the relevant section is known; it is faster than searching the whole document.",
      "Use document_screenshot after document_search when the page area needs visual inspection."
    ],
    parameters: DocumentSearchSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            { type: "text", text: "Document search was cancelled before it started." }
          ],
          details: {}
        };
      }
      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0)
        throw new Error(getRemovedV1OptionsMessage(removedOptions));
      const params = rawParams;
      try {
        validateSearchPhrase(params.phrase);
        const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;
        if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
          throw new Error(`maxResults must be an integer between 1 and ${MAX_RESULTS}.`);
        }
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(input.inspection);
        if (missingHostDependencyMessage)
          throw new Error(missingHostDependencyMessage);
        const warnings = [];
        const parserConfig = buildLiteParseConfig({ ...params, format: "json", preserveSmallText: false }, warnings);
        const result = await executor.execute({
          operation: "search",
          inputPath: input.resolvedPath,
          stagingDir: join3(tmpdir2(), `pi-document-search-${randomUUID3()}`),
          phrase: params.phrase,
          caseSensitive: params.caseSensitive ?? false,
          maxResults,
          config: parserConfig
        }, { signal });
        const truncation = truncateHead(result.hits.map(formatHit).join(`
`), {
          maxLines: PREVIEW_MAX_LINES,
          maxBytes: PREVIEW_MAX_BYTES
        });
        const lines = [
          `Searched document: ${input.sourcePath}`,
          `Resolved path: ${input.resolvedPath}`,
          `Phrase: ${params.phrase}`,
          `Hits returned: ${result.hits.length}`
        ];
        if (result.truncatedByCount)
          lines.push(`Hit results were truncated at the ${maxResults}-result limit.`);
        if (result.truncatedByBytes)
          lines.push("Hit results were truncated at the native response byte limit.");
        if (warnings.length > 0) {
          lines.push("Warnings:");
          for (const warning of warnings)
            lines.push(`- ${warning}`);
        }
        if (truncation.content.trim())
          lines.push("Hits:", truncation.content.trim());
        if (truncation.truncated)
          lines.push("Hit preview truncated. Use structured tool details for the bounded returned hit list.");
        const details = {
          sourcePath: input.sourcePath,
          resolvedPath: input.resolvedPath,
          phrase: params.phrase,
          caseSensitive: params.caseSensitive ?? false,
          hits: result.hits,
          truncatedByCount: result.truncatedByCount,
          truncatedByBytes: result.truncatedByBytes,
          previewTruncated: truncation.truncated,
          warnings: warnings.length > 0 ? warnings : undefined
        };
        return { content: [{ type: "text", text: lines.join(`
`) }], details };
      } catch (error) {
        throw new Error(buildFriendlyErrorMessage2(error));
      }
    }
  });
}
// vendor/docparser/screenshot-tool.ts
import { mkdtemp as mkdtemp2, open as open3, rm as rm3 } from "node:fs/promises";
import { tmpdir as tmpdir3 } from "node:os";
import { join as join4 } from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";
import { Type as Type7 } from "typebox";
var DocumentScreenshotSchema = Type7.Object({
  path: Type7.String({ description: "Path to the document file to screenshot" }),
  pages: Type7.Optional(Type7.String({
    maxLength: MAX_PAGE_SELECTION_BYTES,
    description: `Optional explicit page selection for screenshots, e.g. "1-3,8" (maximum ${MAX_SCREENSHOT_PAGES} pages; default: page 1).`
  })),
  dpi: Type7.Optional(Type7.Integer({
    minimum: MIN_DPI,
    maximum: MAX_DPI,
    description: `Rendering DPI for screenshots (default: ${DEFAULT_DPI})`
  })),
  password: Type7.Optional(Type7.String({ description: "Optional password for encrypted or password-protected documents" }))
});
function normalizeOptionalString2(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
function buildFriendlyErrorMessage3(error) {
  const message = error instanceof NativeExecutionError ? formatNativeExecutionError(error, "Screenshot generation failed.") : error instanceof Error ? error.message : String(error);
  if (isDependencySetupMessage(message))
    return appendDoctorHint(message);
  return message.startsWith("Screenshot generation failed:") ? message : `Screenshot generation failed: ${message}`;
}
async function inlineScreenshots(metadata) {
  const images = [];
  const warnings = [];
  let rawTotal = 0;
  for (const screenshot of metadata.slice(0, MAX_SCREENSHOT_PAGES)) {
    if (screenshot.bytes > INLINE_PNG_MAX_BYTES) {
      warnings.push(`Page ${screenshot.pageNum} was not inlined because ${screenshot.outputPath} exceeds the ${INLINE_PNG_MAX_BYTES}-byte inline limit.`);
      continue;
    }
    if (rawTotal + screenshot.bytes > INLINE_PNG_TOTAL_MAX_BYTES) {
      warnings.push(`Page ${screenshot.pageNum} was not inlined because the ${INLINE_PNG_TOTAL_MAX_BYTES}-byte aggregate inline limit was reached. Saved file: ${screenshot.outputPath}`);
      continue;
    }
    try {
      const handle = await open3(screenshot.outputPath, "r");
      try {
        const fileStats = await handle.stat();
        if (!fileStats.isFile() || fileStats.size !== screenshot.bytes || fileStats.size > INLINE_PNG_MAX_BYTES) {
          warnings.push(`Page ${screenshot.pageNum} was not inlined because its saved PNG size changed. Saved file: ${screenshot.outputPath}`);
          continue;
        }
        if (rawTotal + fileStats.size > INLINE_PNG_TOTAL_MAX_BYTES) {
          warnings.push(`Page ${screenshot.pageNum} was not inlined because the aggregate inline limit was reached. Saved file: ${screenshot.outputPath}`);
          continue;
        }
        const image = Buffer.alloc(fileStats.size);
        const { bytesRead } = await handle.read(image, 0, image.byteLength, 0);
        const finalStats = await handle.stat();
        if (bytesRead !== image.byteLength || finalStats.size !== fileStats.size) {
          warnings.push(`Page ${screenshot.pageNum} was not inlined because its saved PNG changed while reading. Saved file: ${screenshot.outputPath}`);
          continue;
        }
        rawTotal += image.byteLength;
        images.push({ type: "image", mimeType: "image/png", data: image.toString("base64") });
      } finally {
        await handle.close();
      }
    } catch {
      warnings.push(`Page ${screenshot.pageNum} could not be inlined, but remains available at ${screenshot.outputPath}.`);
    }
  }
  return { images, warnings };
}
function registerDocumentScreenshotTool(pi, executor) {
  pi.registerTool({
    name: "document_screenshot",
    label: "Document Screenshot",
    description: "Render up to four local document pages as PNG screenshots with LiteParse v2 and return bounded image blocks plus saved PNG paths.",
    promptSnippet: "Render bounded document pages as PNG images the model can inspect directly; also saves PNGs to temp files.",
    promptGuidelines: [
      "Use document_screenshot when document_parse text is not enough to answer because visual layout, charts, signatures, or figures matter.",
      `Request at most ${MAX_SCREENSHOT_PAGES} explicit pages per call; use bounded repeated calls for more pages.`,
      "Use document_search first when looking for a known phrase, then screenshot only the relevant pages."
    ],
    parameters: DocumentScreenshotSchema,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            {
              type: "text",
              text: "Document screenshot rendering was cancelled before it started."
            }
          ],
          details: {}
        };
      }
      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0)
        throw new Error(getRemovedV1OptionsMessage(removedOptions));
      const params = rawParams;
      const emit = (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} });
      let outputDir;
      try {
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(input.inspection);
        if (missingHostDependencyMessage)
          throw new Error(missingHostDependencyMessage);
        const selection = resolveScreenshotSelection(params.pages);
        outputDir = await mkdtemp2(join4(tmpdir3(), "pi-document-screenshot-"));
        const screenshotDir = join4(outputDir, "screenshots");
        emit(`Rendering screenshots for ${selection.description}...`);
        const result = await executor.execute({
          operation: "screenshot",
          inputPath: input.resolvedPath,
          stagingDir: join4(outputDir, `.screenshot-${randomUUID4()}`),
          outputDir: screenshotDir,
          pages: selection.pageNumbers,
          dpi: params.dpi ?? DEFAULT_DPI,
          password: normalizeOptionalString2(params.password)
        }, { signal });
        const inline = await inlineScreenshots(result.screenshots);
        const lines = [
          `Rendered document screenshots: ${input.sourcePath}`,
          `Resolved path: ${input.resolvedPath}`,
          `Screenshot count: ${result.screenshots.length}`,
          `Screenshots saved to: ${result.screenshotDir}`
        ];
        if (result.screenshots.length > 0) {
          lines.push("Screenshot files:");
          for (const screenshot of result.screenshots.slice(0, MAX_SCREENSHOT_PAGES)) {
            lines.push(`- page ${screenshot.pageNum}: ${screenshot.outputPath}`);
          }
        }
        if (inline.warnings.length > 0) {
          lines.push("Warnings:");
          for (const warning of inline.warnings)
            lines.push(`- ${warning}`);
        }
        const details = {
          sourcePath: input.sourcePath,
          resolvedPath: input.resolvedPath,
          outputDir,
          screenshotDir: result.screenshotDir,
          screenshots: result.screenshots.slice(0, MAX_SCREENSHOT_PAGES),
          warnings: inline.warnings.length > 0 ? inline.warnings : undefined
        };
        return {
          content: [{ type: "text", text: lines.join(`
`) }, ...inline.images],
          details
        };
      } catch (error) {
        if (outputDir)
          await rm3(outputDir, { recursive: true, force: true }).catch(() => {
            return;
          });
        throw new Error(buildFriendlyErrorMessage3(error));
      }
    }
  });
}
export {
  createNativeExecutor,
  docxText,
  registerAlphaTools,
  registerDocumentParseTool,
  registerDocumentScreenshotTool,
  registerDocumentSearchTool,
  registerHuggingFaceTools,
  registerScienceDatabaseTools,
  withResearchRequest
};
