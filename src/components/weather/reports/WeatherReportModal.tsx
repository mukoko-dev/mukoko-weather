"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";
import { useAppStore } from "@/lib/store";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

const REPORT_TYPES = [
  { id: "light-rain", label: "Light Rain", icon: "🌦️" },
  { id: "heavy-rain", label: "Heavy Rain", icon: "🌧️" },
  { id: "thunderstorm", label: "Thunderstorm", icon: "⛈️" },
  { id: "hail", label: "Hail", icon: "🌨️" },
  { id: "flooding", label: "Flooding", icon: "🌊" },
  { id: "strong-wind", label: "Strong Wind", icon: "💨" },
  { id: "clear-skies", label: "Clear Skies", icon: "☀️" },
  { id: "fog", label: "Fog", icon: "🌫️" },
  { id: "dust", label: "Dust", icon: "🏜️" },
  { id: "frost", label: "Frost", icon: "❄️" },
] as const;

const SEVERITIES = [
  { id: "mild", label: "Mild", description: "Noticeable but not disruptive" },
  { id: "moderate", label: "Moderate", description: "Affecting plans or travel" },
  { id: "severe", label: "Severe", description: "Dangerous or highly disruptive" },
] as const;

type Step = "select" | "clarify" | "confirm";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WeatherReportModal() {
  const reportModalOpen = useAppStore((s) => s.reportModalOpen);
  const closeReportModal = useAppStore((s) => s.closeReportModal);
  const selectedLocation = useAppStore((s) => s.selectedLocation);

  const [step, setStep] = useState<Step>("select");
  const [reportType, setReportType] = useState<string | null>(null);
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

    try {
      const res = await fetch("/api/py/reports/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationSlug: selectedLocation,
          reportType: typeId,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setQuestions(data.questions || []);
      }
    } catch {
      // Clarification is optional — continue without it
    } finally {
      setLoading(false);
      setStep("clarify");
    }
  };

  const handleSubmit = async () => {
    if (!reportType) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/py/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationSlug: selectedLocation,
          reportType,
          severity,
          description: description.trim(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || "Failed to submit report");
      }

      setSubmitted(true);
      setStep("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit report");
    } finally {
      setLoading(false);
    }
  };

  const typeInfo = REPORT_TYPES.find((t) => t.id === reportType);

  return (
    <Dialog open={reportModalOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading">
            {step === "confirm" ? "Report Submitted" : "Report Weather"}
          </DialogTitle>
          <DialogDescription>
            {step === "select" && "What are you experiencing right now?"}
            {step === "clarify" && typeInfo && `Tell us more about the ${typeInfo.label.toLowerCase()}`}
            {step === "confirm" && "Thank you for helping your community!"}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Select type */}
        {step === "select" && (
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Weather condition type">
            {REPORT_TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                onClick={() => handleTypeSelect(type.id)}
                disabled={loading}
                className="flex items-center gap-2 rounded-[var(--radius-card)] border border-border bg-surface-card px-3 py-3 text-left text-sm transition-colors hover:bg-surface-dim hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-primary min-h-[44px] disabled:opacity-50"
              >
                <span className="text-lg" aria-hidden="true">{type.icon}</span>
                <span className="text-text-primary font-medium">{type.label}</span>
              </button>
            ))}
          </div>
        )}

        {/* Step 2: Clarify + severity */}
        {step === "clarify" && (
          <div className="space-y-4">
            {/* AI clarification questions */}
            {questions.length > 0 && (
              <div className="rounded-[var(--radius-card)] bg-primary/5 p-3">
                <p className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">Help us understand</p>
                <ul className="space-y-1 text-sm text-text-secondary">
                  {questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Severity selection */}
            <div>
              <p className="text-sm font-medium text-text-primary mb-2">Severity</p>
              <div className="flex gap-2" role="radiogroup" aria-label="Report severity">
                {SEVERITIES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSeverity(s.id)}
                    role="radio"
                    aria-checked={severity === s.id}
                    className={`flex-1 rounded-[var(--radius-input)] border px-3 py-2 text-center text-sm font-medium transition-colors min-h-[44px] ${
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
              <label htmlFor="report-description" className="text-sm font-medium text-text-primary">
                Description <span className="text-text-tertiary">(optional)</span>
              </label>
              <textarea
                id="report-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add any details about what you're seeing..."
                rows={2}
                maxLength={300}
                className="mt-1 w-full resize-none rounded-[var(--radius-input)] border border-input bg-surface-card px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="mt-1 text-xs text-text-tertiary">{description.length}/300</p>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => { setStep("select"); setReportType(null); }}
                className="min-h-[44px]"
              >
                Back
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1 min-h-[44px]"
              >
                {loading ? "Submitting..." : "Submit Report"}
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Confirmation */}
        {step === "confirm" && submitted && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-severity-low/10">
              <span className="text-2xl" aria-hidden="true">
                {typeInfo?.icon || "✓"}
              </span>
            </div>
            <p className="text-sm text-text-secondary">
              Your <strong>{typeInfo?.label}</strong> report has been submitted.
              Other users in the area will see it.
            </p>
            <DialogClose asChild>
              <Button onClick={handleClose} className="min-h-[44px]">Done</Button>
            </DialogClose>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
