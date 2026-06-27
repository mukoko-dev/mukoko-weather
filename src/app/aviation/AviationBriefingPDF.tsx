"use client";

import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

// PDF uses inline hex — CSS custom properties are not supported by @react-pdf/renderer
const NAVY = "#1a2744";
const WHITE = "#ffffff";
const LIGHT_GRAY = "#f5f7fa";
const MID_GRAY = "#94a3b8";
const DARK_GRAY = "#334155";
const VFR_GREEN = "#16a34a";
const MVFR_BLUE = "#2563eb";
const IFR_ORANGE = "#ea580c";
const LIFR_RED = "#dc2626";

const styles = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 9, color: DARK_GRAY, backgroundColor: WHITE, padding: 32 },
  header: { backgroundColor: NAVY, padding: 16, marginBottom: 16, borderRadius: 4 },
  headerTitle: { fontSize: 18, fontFamily: "Helvetica-Bold", color: WHITE, marginBottom: 2 },
  headerSub: { fontSize: 10, color: "#94c4f7" },
  headerRoute: { fontSize: 13, fontFamily: "Helvetica-Bold", color: WHITE, marginTop: 8 },
  headerMeta: { fontSize: 8, color: MID_GRAY, marginTop: 3 },
  section: { marginBottom: 14, padding: 10, backgroundColor: LIGHT_GRAY, borderRadius: 4, borderLeft: `3px solid ${NAVY}` },
  sectionTitle: { fontSize: 11, fontFamily: "Helvetica-Bold", color: NAVY, marginBottom: 6 },
  sectionSubtitle: { fontSize: 8, color: MID_GRAY, marginBottom: 8 },
  row: { flexDirection: "row", gap: 8, marginBottom: 6 },
  col: { flex: 1 },
  label: { fontSize: 7, color: MID_GRAY, marginBottom: 1, textTransform: "uppercase" },
  value: { fontSize: 9, color: DARK_GRAY },
  valueBold: { fontSize: 9, fontFamily: "Helvetica-Bold", color: NAVY },
  raw: { fontFamily: "Courier", fontSize: 8, color: DARK_GRAY, backgroundColor: "#e2e8f0", padding: 6, borderRadius: 2, marginTop: 4 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, fontSize: 8, fontFamily: "Helvetica-Bold", color: WHITE },
  badgeRow: { flexDirection: "row", gap: 8, marginBottom: 8, alignItems: "center" },
  divider: { borderBottom: `1px solid #cbd5e1`, marginVertical: 8 },
  footer: { position: "absolute", bottom: 20, left: 32, right: 32 },
  footerText: { fontSize: 7, color: MID_GRAY, textAlign: "center" },
  disclaimer: { fontSize: 6.5, color: "#ef4444", textAlign: "center", marginTop: 3 },
  tafBlock: { fontFamily: "Courier", fontSize: 7.5, color: DARK_GRAY, backgroundColor: "#e2e8f0", padding: 6, borderRadius: 2, lineHeight: 1.5 },
  condSummary: { flexDirection: "row", gap: 16, marginBottom: 12, padding: 8, backgroundColor: WHITE, borderRadius: 4 },
  condItem: { alignItems: "center", flex: 1 },
  condLabel: { fontSize: 7, color: MID_GRAY, marginBottom: 3 },
});

function fcBadgeColor(fc: string): string {
  switch (fc) {
    case "VFR": return VFR_GREEN;
    case "MVFR": return MVFR_BLUE;
    case "IFR": return IFR_ORANGE;
    case "LIFR": return LIFR_RED;
    default: return MID_GRAY;
  }
}

function windStr(obs: MetarObs): string {
  if (obs.wind_variable) return `Variable ${obs.wind_speed}kt`;
  if (!obs.wind_dir && obs.wind_speed === 0) return "Calm";
  return `${String(obs.wind_dir).padStart(3, "0")}° ${obs.wind_speed}kt`;
}

function cloudsStr(obs: MetarObs): string {
  if (!obs.clouds?.length) return "Clear";
  return obs.clouds.map((c) => `${c.cover} ${c.base_ft}ft`).join(", ");
}

export interface MetarObs {
  time: string;
  temp: number;
  dewp: number;
  wind_dir: number;
  wind_speed: number;
  wind_variable: boolean;
  visibility: string;
  clouds: { cover: string; base_ft: number }[];
  weather: string | null;
  pressure_hpa: number | null;
  flight_category: string;
  change: string | null;
  raw: string;
}

export interface AirportBriefing {
  icao: string;
  name: string;
  metar: MetarObs[];
  taf: string | null;
  sunrise?: string;
  sunset?: string;
}

export interface BriefingData {
  departure: AirportBriefing;
  destination: AirportBriefing;
  alternate?: AirportBriefing;
  generatedAt: string;
}

function AirportSection({ airport, compact = false }: { airport: AirportBriefing; compact?: boolean }) {
  const latest = airport.metar[0];
  const fc = latest?.flight_category ?? "N/A";

  return (
    <View style={styles.section}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <Text style={styles.sectionTitle}>{airport.icao} — {airport.name}</Text>
        {latest && (
          <View style={[styles.badge, { backgroundColor: fcBadgeColor(fc) }]}>
            <Text>{fc}</Text>
          </View>
        )}
      </View>

      {/* Latest METAR */}
      {latest ? (
        <>
          <View style={styles.row}>
            <View style={styles.col}>
              <Text style={styles.label}>Temperature / Dew Point</Text>
              <Text style={styles.value}>{latest.temp}°C / {latest.dewp}°C</Text>
            </View>
            <View style={styles.col}>
              <Text style={styles.label}>Wind</Text>
              <Text style={styles.value}>{windStr(latest)}</Text>
            </View>
            <View style={styles.col}>
              <Text style={styles.label}>Visibility</Text>
              <Text style={styles.value}>{latest.visibility === "9999" ? ">10km" : `${latest.visibility}m`}</Text>
            </View>
            {latest.pressure_hpa && (
              <View style={styles.col}>
                <Text style={styles.label}>QNH</Text>
                <Text style={styles.value}>{latest.pressure_hpa} hPa</Text>
              </View>
            )}
          </View>
          <View style={{ marginBottom: 4 }}>
            <Text style={styles.label}>Clouds</Text>
            <Text style={styles.value}>{cloudsStr(latest)}</Text>
          </View>
          <Text style={styles.raw}>{latest.raw}</Text>
        </>
      ) : (
        <Text style={styles.value}>No METAR available</Text>
      )}

      {!compact && (airport.sunrise || airport.sunset) && (
        <View style={[styles.row, { marginTop: 6 }]}>
          {airport.sunrise && (
            <View style={styles.col}>
              <Text style={styles.label}>Sunrise</Text>
              <Text style={styles.value}>{airport.sunrise}</Text>
            </View>
          )}
          {airport.sunset && (
            <View style={styles.col}>
              <Text style={styles.label}>Sunset</Text>
              <Text style={styles.value}>{airport.sunset}</Text>
            </View>
          )}
        </View>
      )}

      {!compact && airport.taf && (
        <View style={{ marginTop: 8 }}>
          <Text style={[styles.label, { marginBottom: 4 }]}>TAF</Text>
          <Text style={styles.tafBlock}>{airport.taf}</Text>
        </View>
      )}
      {!compact && !airport.taf && (
        <Text style={[styles.sectionSubtitle, { marginTop: 6 }]}>No TAF available for this station.</Text>
      )}
    </View>
  );
}

export function AviationBriefingPDF({ data }: { data: BriefingData }) {
  const depFc = data.departure.metar[0]?.flight_category ?? "N/A";
  const destFc = data.destination.metar[0]?.flight_category ?? "N/A";

  return (
    <Document title={`Weather Briefing ${data.departure.icao}–${data.destination.icao}`} author="mukoko weather">
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>mukoko weather</Text>
          <Text style={styles.headerSub}>Pre-Flight Weather Briefing</Text>
          <Text style={styles.headerRoute}>{data.departure.icao} → {data.destination.icao}</Text>
          <Text style={styles.headerMeta}>Generated: {data.generatedAt}</Text>
        </View>

        {/* Flight conditions summary */}
        <View style={styles.condSummary}>
          <View style={styles.condItem}>
            <Text style={styles.condLabel}>Departure</Text>
            <Text style={styles.valueBold}>{data.departure.icao}</Text>
            <View style={[styles.badge, { backgroundColor: fcBadgeColor(depFc), marginTop: 3 }]}>
              <Text>{depFc}</Text>
            </View>
          </View>
          <View style={[styles.condItem, { borderLeft: `1px solid #cbd5e1`, borderRight: `1px solid #cbd5e1` }]}>
            <Text style={[styles.label, { textAlign: "center" }]}>Conditions at Briefing</Text>
            <Text style={[styles.value, { textAlign: "center", marginTop: 4 }]}>
              {depFc === "VFR" && destFc === "VFR" ? "✓ VFR throughout" : "Check individual stations"}
            </Text>
          </View>
          <View style={styles.condItem}>
            <Text style={styles.condLabel}>Destination</Text>
            <Text style={styles.valueBold}>{data.destination.icao}</Text>
            <View style={[styles.badge, { backgroundColor: fcBadgeColor(destFc), marginTop: 3 }]}>
              <Text>{destFc}</Text>
            </View>
          </View>
        </View>

        {/* Airport sections */}
        <AirportSection airport={data.departure} />
        <AirportSection airport={data.destination} />
        {data.alternate && <AirportSection airport={data.alternate} compact />}

        {/* Footer */}
        <View style={styles.footer}>
          <View style={styles.divider} />
          <Text style={styles.footerText}>
            Generated by mukoko weather · weather.mukoko.com · {data.generatedAt}
          </Text>
          <Text style={styles.disclaimer}>
            This briefing is for planning purposes only. Always obtain an official pre-flight briefing from your national aviation authority.
          </Text>
        </View>
      </Page>
    </Document>
  );
}
