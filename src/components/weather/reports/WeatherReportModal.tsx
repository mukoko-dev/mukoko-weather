"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { useAppStore } from "@/lib/store";
import { trackEvent } from "@/lib/analytics";
import { REPORT_TYPES, getReportTypeInfo } from "@/lib/report-types";
import {
  CLARIFY_TIMEOUT_MS,
  clarifyQuestions,
  forgetReports,
  reportRefusal,
  reportsSubmitUrl,
} from "@/lib/reports-api";
import { postWorker } from "@/lib/weather-api";
import { Alert, AlertDescription } from "@/components/ui/alert";

const SEVERITIES = [
  { id: "mild", label: "Mild", description: "Noticeable but not disruptive" },
  {
    id: "moderate",
    label: "Moderate",
    description: "Affecting plans or travel",
  },
  {
    id: "severe",
    label: "Severe",
    description: "Dangerous or highly disruptive",
  },
] as const;

type Step = "select" | "clarify" | "confirm";

/**
 * The wizard's follow-up questions for a type: the Worker's answer, or none
 * (clarification is optional, so any failure carries on without questions).
 */
async function fetchQuestions(
  locationSlug: string,
  reportType: string,
): Promise<string[]> {
  try {
    const res = await postWorker(
      "reports/clarify",
      { locationSlug, reportType },
      { timeoutMs: CLARIFY_TIMEOUT_MS },
    );
    return res.ok ? clarifyQuestions(await res.json()) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WeatherReportModal() {
  const reportModalOpen = useAppStore((s) => s.reportModalOpen);
  const closeReportModal = useAppStore((s) => s.closeReportModal);
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  // Opened from an alert ("Report flooding"): the type is already chosen and
  // the report is for that alert's place. Read once, when the wizard mounts
  // (it is mounted only while open). A type this build does not know is
  // ignored, so a button can never open the wizard on nothing.
  const [opened] = useState(() => {
    const preset = useAppStore.getState().reportPreset;
    return {
      type:
        preset?.reportType && getReportTypeInfo(preset.reportType)
          ? preset.reportType
          : null,
      slug: preset?.locationSlug ?? null,
    };
  });
  const locationSlug = opened.slug ?? selectedLocation;

  const [step, setStep] = useState<Step>(opened.type ? "clarify" : "select");
  const [reportType, setReportType] = useState<string | null>(opened.type);
  const [severity, setSeverity] = useState("moderate");
  const [description, setDescription] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep("select");
    setReportType(null);
    setSeverity("moderate");
    setDescription("");
    setQuestions([]);
    setLoading(false);
    setSubmitted(false);
    setError(null);
  }, []);

  const handleClose = () => {
    closeReportModal();
    setTimeout(reset, 300);
  };

  const handleTypeSelect = async (typeId: string) => {
    setReportType(typeId);
    setLoading(true);
    setQuestions(await fetchQuestions(locationSlug, typeId));
    setLoading(false);
    setStep("clarify");
  };

  // Opened on a type: the step shows at once and the questions arrive when the
  // Worker answers (the severity and the description do not wait for them).
  useEffect(() => {
    if (!opened.type) return;
    let alive = true;
    void fetchQuestions(locationSlug, opened.type).then((q) => {
      if (alive) setQuestions(q);
    });
    return () => {
      alive = false;
    };
  }, [opened.type, locationSlug]);

  const handleSubmit = async () => {
    if (!reportType) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(reportsSubmitUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationSlug,
          reportType,
          severity,
          description: description.trim(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(reportRefusal(body, "Failed to submit report"));
      }

      // The kept list for this place is now out of date.
      forgetReports(locationSlug);
      setSubmitted(true);
      setStep("confirm");
      trackEvent("report_submitted", {
        type: reportType,
        severity,
        location: locationSlug,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit report");
    } finally {
      setLoading(false);
    }
  };

  const typeInfo = REPORT_TYPES.find((t) => t.id === reportType);

  return (
    <Dialog
      open={reportModalOpen}
      onOpenChange={(open) => {
        if (open) trackEvent("modal_opened", { modal: "weather-report" });
        else handleClose();
      }}
    >
      <DialogContent
        heading={step === "confirm" ? "Report Submitted" : "Report Weather"}
        className="sm:max-w-md"
      >
        {/* Description (the title is pinned in the top bar) */}
        <DialogHeader className="px-5 py-3">
          <DialogDescription className="mt-0.5 text-base text-text-secondary">
            {step === "select" && "What are you experiencing right now?"}
            {step === "clarify" &&
              typeInfo &&
              `Tell us more about the ${typeInfo.label.toLowerCase()}`}
            {step === "confirm" && "Thank you for helping your community!"}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Select type */}
        {step === "select" && (
          <div className="px-5 pb-5">
            <div
              className="grid grid-cols-2 gap-2"
              role="group"
              aria-label="Weather condition type"
            >
              {REPORT_TYPES.map((type) => {
                const Icon = type.icon;
                return (
                  <button
                    key={type.id}
                    type="button"
                    onClick={() => handleTypeSelect(type.id)}
                    disabled={loading}
                    className="flex items-center gap-2.5 rounded-[var(--radius-button)] border border-border bg-surface-card px-3 py-3 text-left text-base transition-colors max-[390px]:flex-col max-[390px]:justify-center max-[390px]:gap-[var(--gap-floor)] max-[390px]:text-center hover:bg-surface-dim hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-primary min-h-[var(--touch-target-min)] disabled:opacity-50"
                  >
                    <Icon size={20} className="shrink-0 text-text-secondary" />
                    <span className="text-text-primary font-medium">
                      {type.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 2: Clarify + severity */}
        {step === "clarify" && (
          <div className="space-y-4 px-5 pb-5">
            {/* A type where someone could be in danger says what this is not,
                before anything is sent. */}
            {typeInfo?.notice && (
              <Alert variant="warning" role="note">
                <AlertDescription className="mt-0 font-medium">
                  {typeInfo.notice}
                </AlertDescription>
              </Alert>
            )}

            {/* AI clarification questions */}
            {questions.length > 0 && (
              <div className="rounded-[var(--radius-button)] bg-primary/5 p-3">
                <p className="hornbill font-medium mb-2">Help us understand</p>
                <ul className="space-y-1 text-base text-text-secondary">
                  {questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Severity selection */}
            <div>
              <p className="text-base font-medium text-text-primary mb-2">
                Severity
              </p>
              <div
                className="flex gap-2"
                role="radiogroup"
                aria-label="Report severity"
              >
                {SEVERITIES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSeverity(s.id)}
                    role="radio"
                    aria-checked={severity === s.id}
                    className={`flex-1 rounded-[var(--radius-button)] border px-3 py-2 text-center text-base font-medium transition-colors min-h-[var(--touch-target-min)] ${
                      severity === s.id
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-text-secondary hover:border-primary/30"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Description */}
            <div>
              <label
                htmlFor="report-description"
                className="text-base font-medium text-text-primary"
              >
                Description{" "}
                <span className="text-text-tertiary">(optional)</span>
              </label>
              <textarea
                id="report-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add any details about what you're seeing..."
                rows={2}
                maxLength={300}
                className="crane mt-1 resize-none rounded-[var(--radius-button)]"
              />
              <p className="mt-1 text-base text-text-tertiary">
                {description.length}/300
              </p>
            </div>

            {error && <p className="text-base text-destructive">{error}</p>}

            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => {
                  setStep("select");
                  setReportType(null);
                }}
              >
                Back
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1"
              >
                {loading ? "Submitting..." : "Submit Report"}
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Confirmation */}
        {step === "confirm" && submitted && (
          <div className="space-y-4 px-5 pb-5 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-severity-low/10">
              {typeInfo ? (
                <typeInfo.icon size={26} className="text-severity-low" />
              ) : (
                <span className="text-2xl" aria-hidden="true">
                  ✓
                </span>
              )}
            </div>
            <p className="text-base text-text-secondary">
              Your <strong>{typeInfo?.label}</strong> report has been submitted.
              Other users in the area will see it.
            </p>
            {typeInfo?.sentNote && (
              <p className="text-base text-text-secondary">
                {typeInfo.sentNote}
              </p>
            )}
            {typeInfo?.notice && (
              <p className="text-base font-medium text-text-primary">
                {typeInfo.notice}
              </p>
            )}
            <DialogClose asChild>
              <Button onClick={handleClose}>Done</Button>
            </DialogClose>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
