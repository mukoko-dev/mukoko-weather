import { withAuth } from "@workos-inc/authkit-nextjs";
import { Console } from "@/components/Console";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * `/` is public: anonymous visitors see the landing page below; signed-in
 * station owners go straight to the console. The middleware lists "/" in
 * unauthenticatedPaths — everything else stays auth-gated, and the console
 * itself only renders when withAuth() returns a user.
 */
export default async function Home() {
  const { user } = await withAuth();

  if (user) {
    return <Console userEmail={user.email ?? ""} userId={user.id} />;
  }

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-4 py-12 sm:p-8 sm:py-16">
      <header className="space-y-4">
        <h1 className="font-serif text-3xl font-semibold sm:text-4xl">
          mukoko weather stations
        </h1>
        <p className="text-lg text-muted-foreground">
          Put your weather station on the map. Readings from community stations
          feed live current conditions on{" "}
          <a
            href="https://weather.mukoko.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cobalt underline underline-offset-4"
          >
            weather.mukoko.com
          </a>{" "}
          for everyone nearby — farmers, schools, pilots, and neighbours.
        </p>
        <Button asChild>
          <a href="/auth/signin">Sign in to register your station</a>
        </Button>
      </header>

      <section aria-label="How it works" className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Digital stations</CardTitle>
            <CardDescription>
              Ecowitt, Fine Offset, Ambient-style consoles and compatibles
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Point your console&apos;s &ldquo;customized upload&rdquo; at our
            servers — Wunderground and Ecowitt protocols are both supported. No
            Weather Underground account needed: your data goes straight to the
            mukoko network, quality-checked on arrival.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Analog stations</CardTitle>
            <CardDescription>
              Rain gauge and thermometer — no electronics required
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Farms and schools with manual instruments can log readings right
            here in the console. Each entry passes the same quality checks and
            joins the network alongside digital stations.
          </CardContent>
        </Card>
      </section>

      <p className="text-sm text-muted-foreground">
        Registration is free. You get a station ID and a private ingest key —
        shown once, stored only as a salted hash on our side. Full setup
        instructions live in the{" "}
        <a
          href="https://docs.nyuchi.com/mukoko-weather/weather-stations/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-cobalt underline underline-offset-4"
        >
          weather stations guide
        </a>
        .
      </p>
    </main>
  );
}
