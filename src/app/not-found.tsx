import { LocationNotFound } from "@/components/layout/LocationNotFound";

// Root not-found boundary. `[location]/layout.tsx` calls notFound() for an
// unknown slug; a layout's own not-found.tsx can't catch its throw, so the
// root boundary renders it — with the same UI as `[location]/not-found.tsx`
// and a real 404 status (#237). Any other unmatched URL lands here too.
export default LocationNotFound;
