/**
 * Literature search over free scholarly APIs (no keys needed): OpenAlex, Semantic Scholar, PubMed, arXiv.
 * Parsers are pure (tested on fixtures); `searchAll` does the network calls and de-duplicates.
 */

export type PaperSourceName = "openalex" | "semanticscholar" | "pubmed" | "arxiv";

export interface Paper {
	/** Stable short id assigned after de-duplication (P1, P2, …). */
	id: string;
	title: string;
	year?: number;
	doi?: string;
	url?: string;
	abstract: string;
	authors: string[];
	venue?: string;
	citations?: number;
	oaPdf?: string;
	retracted?: boolean;
	sources: PaperSourceName[];
}

type Raw = Omit<Paper, "id">;

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "");
const normDoi = (doi?: string | null) => (doi ? doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim() : undefined);
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const decodeXml = (s: string) =>
	s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");

/** OpenAlex stores abstracts as an inverted index: word -> positions. */
export function invertedToText(index: Record<string, number[]> | null | undefined): string {
	if (!index) return "";
	const words: string[] = [];
	for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
	return words.filter(Boolean).join(" ");
}

export function parseOpenAlex(json: any): Raw[] {
	return (json?.results ?? []).map((w: any) => ({
		title: clean(w.display_name ?? w.title),
		year: w.publication_year ?? undefined,
		doi: normDoi(w.doi),
		url: w.doi ?? w.id,
		abstract: invertedToText(w.abstract_inverted_index),
		authors: (w.authorships ?? []).slice(0, 6).map((a: any) => a.author?.display_name).filter(Boolean),
		venue: w.primary_location?.source?.display_name ?? undefined,
		citations: w.cited_by_count ?? undefined,
		oaPdf: w.open_access?.oa_url ?? undefined,
		retracted: w.is_retracted === true,
		sources: ["openalex"],
	}));
}

export function parseSemanticScholar(json: any): Raw[] {
	return (json?.data ?? []).map((p: any) => ({
		title: clean(p.title),
		year: p.year ?? undefined,
		doi: normDoi(p.externalIds?.DOI),
		url: p.url,
		abstract: clean(p.abstract),
		authors: (p.authors ?? []).slice(0, 6).map((a: any) => a.name).filter(Boolean),
		venue: p.venue || undefined,
		citations: p.citationCount ?? undefined,
		oaPdf: p.openAccessPdf?.url ?? undefined,
		sources: ["semanticscholar"],
	}));
}

export function parsePubmedXml(xml: string): Raw[] {
	return [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)].map(([, a]) => {
		const tag = (name: string) => decodeXml(clean(a.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? ""));
		const abstract = [...a.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
			.map(([, attrs, text]) => {
				const label = attrs.match(/Label="([^"]+)"/)?.[1];
				return `${label ? `${label}: ` : ""}${decodeXml(clean(text))}`;
			})
			.join(" ");
		const pmid = tag("PMID");
		const authors = [...a.matchAll(/<Author[\s\S]*?<LastName>([^<]+)<\/LastName>[\s\S]*?(?:<Initials>([^<]+)<\/Initials>)?[\s\S]*?<\/Author>/g)]
			.slice(0, 6)
			.map(([, last, initials]) => `${last}${initials ? ` ${initials}` : ""}`);
		return {
			title: tag("ArticleTitle"),
			year: Number(a.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/)?.[1]) || undefined,
			doi: normDoi(a.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/)?.[1]),
			url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : undefined,
			abstract,
			authors,
			venue: tag("Title") || undefined,
			retracted: /Retracted Publication/.test(a),
			sources: ["pubmed"] as PaperSourceName[],
		};
	});
}

export function parseArxivAtom(xml: string): Raw[] {
	return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
		const tag = (name: string) => decodeXml(clean(e.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? ""));
		const id = tag("id");
		return {
			title: tag("title"),
			year: Number(tag("published").slice(0, 4)) || undefined,
			doi: normDoi(e.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/)?.[1]),
			url: id,
			abstract: tag("summary"),
			authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].slice(0, 6).map((m) => m[1]),
			venue: "arXiv",
			oaPdf: id ? id.replace("/abs/", "/pdf/") : undefined,
			sources: ["arxiv"] as PaperSourceName[],
		};
	});
}

/** Merge duplicates by DOI, else normalized title; keep the richest fields and union the sources. */
export function dedupe(raws: readonly Raw[]): { papers: Paper[]; duplicates: number } {
	const byKey = new Map<string, Raw>();
	let duplicates = 0;
	for (const r of raws) {
		if (!r.title) continue;
		const key = r.doi ?? `t:${normTitle(r.title)}`;
		const titleKey = `t:${normTitle(r.title)}`;
		const existing = byKey.get(key) ?? byKey.get(titleKey);
		if (!existing) {
			byKey.set(key, { ...r });
			if (key !== titleKey) byKey.set(titleKey, byKey.get(key)!);
			continue;
		}
		duplicates++;
		existing.abstract = existing.abstract.length >= r.abstract.length ? existing.abstract : r.abstract;
		existing.doi ??= r.doi;
		existing.year ??= r.year;
		existing.oaPdf ??= r.oaPdf;
		existing.citations = Math.max(existing.citations ?? 0, r.citations ?? 0) || undefined;
		existing.retracted = existing.retracted || r.retracted;
		existing.sources = [...new Set([...existing.sources, ...r.sources])];
		if (r.doi && !byKey.has(r.doi)) byKey.set(r.doi, existing);
	}
	const unique = [...new Set(byKey.values())];
	return { papers: unique.map((p, i) => ({ id: `P${i + 1}`, ...p })), duplicates };
}

const UA = { "User-Agent": "npi/0.1 (science mode; https://github.com/portokallidis/npi)" };

async function getJson(url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<any> {
	const res = await fetch(url, { headers: { ...UA, ...headers }, signal });
	if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
	return res.json();
}
async function getText(url: string, signal?: AbortSignal): Promise<string> {
	const res = await fetch(url, { headers: UA, signal });
	if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
	return res.text();
}

export const SOURCES: Record<PaperSourceName, (q: string, n: number, fromYear: number | undefined, signal?: AbortSignal) => Promise<Raw[]>> = {
	async openalex(q, n, fromYear, signal) {
		const filter = fromYear ? `&filter=from_publication_date:${fromYear}-01-01` : "";
		return parseOpenAlex(await getJson(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${n}${filter}`, {}, signal));
	},
	async semanticscholar(q, n, fromYear, signal) {
		const fields = "title,abstract,year,externalIds,citationCount,url,openAccessPdf,authors,venue";
		const year = fromYear ? `&year=${fromYear}-` : "";
		const key: Record<string, string> = process.env.SEMANTIC_SCHOLAR_API_KEY ? { "x-api-key": process.env.SEMANTIC_SCHOLAR_API_KEY } : {};
		return parseSemanticScholar(await getJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${n}&fields=${fields}${year}`, key, signal));
	},
	async pubmed(q, n, fromYear, signal) {
		const term = fromYear ? `${q} AND ${fromYear}:3000[dp]` : q;
		const ids: string[] = (await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${n}&term=${encodeURIComponent(term)}`, {}, signal))?.esearchresult?.idlist ?? [];
		if (!ids.length) return [];
		return parsePubmedXml(await getText(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=${ids.join(",")}`, signal));
	},
	async arxiv(q, n, _fromYear, signal) {
		return parseArxivAtom(await getText(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=${n}&sortBy=relevance`, signal));
	},
};

export interface SearchLogEntry {
	source: PaperSourceName;
	query: string;
	found: number;
	error?: string;
	at: string;
}

/** Run every query on every source (in parallel), log each search for reproducibility, then de-duplicate. */
/** Minimum gap between requests to one database (their public rate limits, without keys). */
const MIN_GAP_MS: Record<PaperSourceName, number> = { openalex: 150, semanticscholar: 1100, pubmed: 400, arxiv: 3000 };
const RETRIES = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run every query on every source, log each search for reproducibility, then de-duplicate.
 * Sources run in parallel; queries to the same source run one after another with its rate-limit gap,
 * and HTTP 429/503 responses are retried with backoff.
 */
export async function searchAll(
	queries: readonly string[],
	sources: readonly PaperSourceName[],
	options: { perQuery: number; fromYear?: number; signal?: AbortSignal; impl?: typeof SOURCES; gapMs?: Partial<Record<PaperSourceName, number>> },
): Promise<{ papers: Paper[]; identified: number; duplicates: number; log: SearchLogEntry[] }> {
	const impl = options.impl ?? SOURCES;
	const log: SearchLogEntry[] = [];
	const perSource = await Promise.all(
		sources.map(async (source) => {
			const gap = options.gapMs?.[source] ?? MIN_GAP_MS[source];
			const found: Raw[][] = [];
			for (const [i, query] of queries.entries()) {
				if (i > 0) await sleep(gap);
				const at = new Date().toISOString();
				for (let attempt = 0; ; attempt++) {
					try {
						const results = await impl[source](query, options.perQuery, options.fromYear, options.signal);
						log.push({ source, query, found: results.length, at });
						found.push(results);
						break;
					} catch (error) {
						const message = (error as Error).message;
						if (attempt < RETRIES && /HTTP (429|503)/.test(message) && !options.signal?.aborted) {
							await sleep(gap * 2 ** (attempt + 1) + 500);
							continue;
						}
						log.push({ source, query, found: 0, error: message, at });
						break;
					}
				}
			}
			return found.flat();
		}),
	);
	const raws = perSource.flat();
	const { papers, duplicates } = dedupe(raws);
	return { papers, identified: raws.length, duplicates, log };
}

export function bibtex(p: Paper): string {
	const key = `${(p.authors[0] ?? "anon").split(/\s+/)[0].replace(/[^A-Za-z]/g, "")}${p.year ?? ""}${p.id}`;
	const fields = [
		`  title = {${p.title}}`,
		p.authors.length ? `  author = {${p.authors.join(" and ")}}` : "",
		p.year ? `  year = {${p.year}}` : "",
		p.venue ? `  journal = {${p.venue}}` : "",
		p.doi ? `  doi = {${p.doi}}` : "",
		p.url ? `  url = {${p.url}}` : "",
	].filter(Boolean);
	return `@article{${key},\n${fields.join(",\n")}\n}`;
}
