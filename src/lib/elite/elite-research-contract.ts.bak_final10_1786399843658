export type EliteResearchSource = {
  id?: string;
  title?: string;
  url?: string;
  author?: string;
  publisher?: string;
  published_at?: string;
  source_type?: string;
  reliability_score?: number;
  extracted_text?: string;
};

export type EliteResearchFact = {
  claim: string;
  status: "VERIFIED" | "PARTIALLY_VERIFIED" | "DISPUTED" | "UNVERIFIED" | "REJECTED";
  confidence?: number;
  source_titles?: string[];
  notes?: string;
};

export function compactResearchForPrompt(args: {
  sources?: EliteResearchSource[];
  facts?: EliteResearchFact[];
  maxChars?: number;
}): string {
  const maxChars = Math.max(5000, Number(args.maxChars || 30000) || 30000);
  const sources = Array.isArray(args.sources) ? args.sources : [];
  const facts = Array.isArray(args.facts) ? args.facts : [];

  const lines: string[] = [];

  lines.push("EXPEDIENTE DE INVESTIGACIÓN ELITE");
  lines.push("");

  if (sources.length) {
    lines.push("FUENTES:");
    for (const source of sources.slice(0, 30)) {
      lines.push("- " + [
        source.title || "Sin título",
        source.publisher ? "Entidad: " + source.publisher : "",
        source.author ? "Autor: " + source.author : "",
        source.published_at ? "Fecha: " + source.published_at : "",
        source.source_type ? "Tipo: " + source.source_type : "",
        typeof source.reliability_score === "number" ? "Confiabilidad: " + source.reliability_score + "/10" : "",
        source.url ? "URL: " + source.url : "",
      ].filter(Boolean).join(" | "));
    }
    lines.push("");
  }

  if (facts.length) {
    lines.push("HECHOS Y AFIRMACIONES:");
    for (const fact of facts.slice(0, 80)) {
      lines.push("- [" + fact.status + "] " + fact.claim);
      if (typeof fact.confidence === "number") {
        lines.push("  Confianza: " + fact.confidence);
      }
      if (fact.source_titles?.length) {
        lines.push("  Fuentes: " + fact.source_titles.join("; "));
      }
      if (fact.notes) {
        lines.push("  Notas: " + fact.notes);
      }
    }
    lines.push("");
  }

  if (!sources.length && !facts.length) {
    lines.push("No hay fuentes ni hechos verificados adjuntos.");
    lines.push("El modelo debe trabajar con prudencia y no inventar datos.");
  }

  return lines.join("\n").slice(0, maxChars);
}

export const ELITE_RESEARCH_STATUS = [
  "VERIFIED",
  "PARTIALLY_VERIFIED",
  "DISPUTED",
  "UNVERIFIED",
  "REJECTED",
] as const;

export function sourceReliabilityHint(source: EliteResearchSource): string {
  const type = String(source.source_type || "").toLowerCase();

  if (/official|oficial|government|gobierno|ley|sentencia|court|statistics|estad[ií]stica/.test(type)) {
    return "Alta prioridad: fuente primaria u oficial.";
  }

  if (/academic|paper|journal|universidad|research|libro/.test(type)) {
    return "Alta prioridad: fuente académica o bibliográfica.";
  }

  if (/news|period[ií]stico|media|periódico|prensa/.test(type)) {
    return "Media prioridad: fuente periodística.";
  }

  if (/blog|social|youtube|facebook|instagram|tiktok/.test(type)) {
    return "Baja prioridad factual: útil para percepción pública, no como prueba principal.";
  }

  return "Prioridad pendiente de clasificación.";
}
