import { describe, expect, it } from "vitest";
import { bibtex, dedupe, invertedToText, parseArxivAtom, parseOpenAlex, parsePubmedXml, parseSemanticScholar, searchAll } from "../src/science/papers.ts";

const openalex = {
	results: [
		{
			display_name: "Exercise and depression: a meta-analysis",
			publication_year: 2021,
			doi: "https://doi.org/10.1000/ABC",
			id: "https://openalex.org/W1",
			abstract_inverted_index: { Exercise: [0], reduces: [1], depressive: [2], symptoms: [3] },
			authorships: [{ author: { display_name: "A. Smith" } }],
			primary_location: { source: { display_name: "BMJ" } },
			cited_by_count: 120,
			open_access: { oa_url: "https://x/pdf" },
			is_retracted: false,
		},
	],
};
const s2 = {
	data: [
		{ title: "Exercise and Depression: A Meta-Analysis", year: 2021, externalIds: { DOI: "10.1000/abc" }, abstract: "Longer abstract text about exercise reducing depressive symptoms.", authors: [{ name: "Alice Smith" }], citationCount: 130, url: "https://s2/1" },
		{ title: "Yoga for anxiety", year: 2019, externalIds: {}, abstract: "", authors: [], url: "https://s2/2" },
	],
};
const pubmed = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article><Journal><Title>Lancet</Title></Journal><ArticleTitle>Yoga for anxiety</ArticleTitle><Abstract><AbstractText Label="RESULTS">Anxiety fell &amp; stayed low.</AbstractText></Abstract><AuthorList><Author><LastName>Lee</LastName><Initials>K</Initials></Author></AuthorList></Article></MedlineCitation><PubmedData><History><PubDate><Year>2019</Year></PubDate></History><ArticleIdList><ArticleId IdType="doi">10.2000/YOGA</ArticleId></ArticleIdList><PublicationTypeList><PublicationType>Retracted Publication</PublicationType></PublicationTypeList></PubmedData></PubmedArticle></PubmedArticleSet>`;
const arxiv = `<feed><entry><id>http://arxiv.org/abs/2101.00001v1</id><published>2021-01-01T00:00:00Z</published><title>Deep nets</title><summary>We study nets.</summary><author><name>Bo Chen</name></author></entry></feed>`;

describe("papers", () => {
	it("parses each source", () => {
		expect(invertedToText({ b: [1], a: [0] })).toBe("a b");
		expect(parseOpenAlex(openalex)[0]).toMatchObject({ doi: "10.1000/abc", abstract: "Exercise reduces depressive symptoms", citations: 120, venue: "BMJ" });
		expect(parseSemanticScholar(s2)[0]).toMatchObject({ doi: "10.1000/abc", citations: 130 });
		expect(parsePubmedXml(pubmed)[0]).toMatchObject({ title: "Yoga for anxiety", doi: "10.2000/yoga", abstract: "RESULTS: Anxiety fell & stayed low.", authors: ["Lee K"], retracted: true, url: "https://pubmed.ncbi.nlm.nih.gov/123/" });
		expect(parseArxivAtom(arxiv)[0]).toMatchObject({ title: "Deep nets", year: 2021, oaPdf: "http://arxiv.org/pdf/2101.00001v1" });
	});

	it("de-duplicates by DOI and title, merging the richest fields", () => {
		const { papers, duplicates } = dedupe([...parseOpenAlex(openalex), ...parseSemanticScholar(s2), ...parsePubmedXml(pubmed)]);
		expect(duplicates).toBe(2);
		expect(papers).toHaveLength(2);
		expect(papers[0]).toMatchObject({ id: "P1", citations: 130, sources: ["openalex", "semanticscholar"] });
		expect(papers[0].abstract).toMatch(/^Longer abstract/);
		expect(papers[1]).toMatchObject({ id: "P2", doi: "10.2000/yoga", retracted: true });
		expect(bibtex(papers[0])).toMatch(/@article\{A2021P1,[\s\S]*doi = \{10\.1000\/abc\}/);
	});

	it("searches all sources, logs every query (including failures) and de-duplicates", async () => {
		const impl = {
			openalex: async () => parseOpenAlex(openalex),
			semanticscholar: async () => parseSemanticScholar(s2),
			pubmed: async () => {
				throw new Error("HTTP 429");
			},
			arxiv: async () => parseArxivAtom(arxiv),
		};
		const gapMs = { openalex: 0, semanticscholar: 0, pubmed: 0, arxiv: 0 };
		const r = await searchAll(["exercise depression"], ["openalex", "semanticscholar", "pubmed", "arxiv"], { perQuery: 5, impl, gapMs });
		expect(r.identified).toBe(4);
		expect(r.papers).toHaveLength(3);
		expect(r.log.find((l) => l.source === "pubmed")).toMatchObject({ found: 0, error: "HTTP 429" });
	});

	it("retries rate-limited requests and spaces queries per source", async () => {
		let calls = 0;
		const flaky = async () => {
			if (++calls === 1) throw new Error("api: HTTP 429");
			return parseArxivAtom(arxiv);
		};
		const impl = { openalex: flaky, semanticscholar: flaky, pubmed: flaky, arxiv: flaky };
		const r = await searchAll(["q1", "q2"], ["pubmed"], { perQuery: 5, impl, gapMs: { pubmed: 1 } });
		expect(calls).toBe(3);
		expect(r.log.map((l) => [l.query, l.found, l.error])).toEqual([
			["q1", 1, undefined],
			["q2", 1, undefined],
		]);
	});
});
