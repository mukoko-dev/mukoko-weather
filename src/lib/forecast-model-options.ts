/**
 * The rows of the forecast-model picker (My Weather → Settings → Forecast
 * model): the blend first, then the individual models. Pure, so what a person
 * is OFFERED is tested without rendering the modal.
 *
 * Apple Weather is a row only while it is offered (`appleWeatherEnabled`): a
 * row that does nothing would be a lie, and until the Servers API origin
 * (Gwaihir) serves `apple_weatherkit` the Worker answers the blend.
 */

import { appleWeatherEnabled } from "./forecast-sources";
import { FORECAST_MODEL_LABELS, ForecastModel } from "./weather";

export interface ModelOption {
  value: ForecastModel;
  label: string;
}

const option = (value: ForecastModel): ModelOption => ({
  value,
  label: FORECAST_MODEL_LABELS[value],
});

/** The blend (best_match) first, then the individual national/agency models. */
export const OPEN_METEO_MODEL_OPTIONS: readonly ModelOption[] = [
  option(ForecastModel.BestMatch),
  option(ForecastModel.ECMWF),
  option(ForecastModel.AIFS),
  option(ForecastModel.GFS),
  option(ForecastModel.ICON),
  option(ForecastModel.MeteoFrance),
];

/** The picker's rows. Apple Weather is last, and only while it is offered. */
export function modelOptions(
  appleOffered: boolean = appleWeatherEnabled(),
): readonly ModelOption[] {
  return appleOffered
    ? [...OPEN_METEO_MODEL_OPTIONS, option(ForecastModel.AppleWeatherKit)]
    : OPEN_METEO_MODEL_OPTIONS;
}
