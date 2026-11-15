//! RFC 9457 problem documents (`application/problem+json`).

use serde_json::json;

/// The media type of a problem document.
pub const CONTENT_TYPE: &str = "application/problem+json";

/// Problem `type` URIs are identifiers under this base. They name the kind of
/// problem; nothing promises that they resolve (RFC 9457 section 3.1.1).
pub const TYPE_BASE: &str = "https://weather.mukoko.com/problems/";

/// A problem to send. `detail` is for the person reading it and never carries
/// a secret, a header or a body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub status: u16,
    /// The last segment of `type`.
    pub kind: &'static str,
    pub title: &'static str,
    pub detail: String,
}

impl Problem {
    fn new(
        status: u16,
        kind: &'static str,
        title: &'static str,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            status,
            kind,
            title,
            detail: detail.into(),
        }
    }

    /// `400`: the path cannot be a route.
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(400, "bad-request", "Bad request", detail)
    }

    /// `404`: nothing here, and nothing was ever here.
    pub fn not_found() -> Self {
        Self::new(
            404,
            "not-found",
            "Not found",
            "No page or file is served at this path.",
        )
    }

    /// `404`: the Next.js app serves this route and this Worker does not (yet).
    pub fn not_migrated(pattern: &str) -> Self {
        Self::new(
            404,
            "not-migrated",
            "Route not migrated",
            format!(
                "The route {pattern} is served by the Next.js app, which this Worker does not route to yet."
            ),
        )
    }

    /// `405`: the path exists, the method does not.
    pub fn method_not_allowed(allow: &str) -> Self {
        Self::new(
            405,
            "method-not-allowed",
            "Method not allowed",
            format!("This path answers {allow}."),
        )
    }

    /// `413`: a body over the limit.
    pub fn payload_too_large(limit: u64) -> Self {
        Self::new(
            413,
            "payload-too-large",
            "Payload too large",
            format!("The request body may be at most {limit} bytes."),
        )
    }

    /// `500`: something failed in the Worker. The cause goes to the log, not here.
    pub fn internal() -> Self {
        Self::new(
            500,
            "internal-error",
            "Internal error",
            "The request could not be served. Try again.",
        )
    }

    /// `502`: the legacy origin did not answer.
    pub fn bad_gateway() -> Self {
        Self::new(
            502,
            "bad-gateway",
            "Bad gateway",
            "The origin that serves this route did not answer.",
        )
    }

    /// `503`: the Worker's own dependency (the static assets) is not ready.
    pub fn unavailable(detail: impl Into<String>) -> Self {
        Self::new(503, "unavailable", "Service unavailable", detail)
    }

    /// The document. `instance` is the request path.
    pub fn to_json(&self, instance: &str) -> String {
        json!({
            "type": format!("{TYPE_BASE}{}", self.kind),
            "title": self.title,
            "status": self.status,
            "detail": self.detail,
            "instance": instance,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_has_the_rfc_9457_members() {
        let doc: serde_json::Value =
            serde_json::from_str(&Problem::not_found().to_json("/nope")).unwrap();
        assert_eq!(doc["type"], "https://weather.mukoko.com/problems/not-found");
        assert_eq!(doc["title"], "Not found");
        assert_eq!(doc["status"], 404);
        assert_eq!(doc["instance"], "/nope");
        assert!(doc["detail"].as_str().unwrap().len() > 10);
    }

    #[test]
    fn instance_is_escaped_not_trusted() {
        let doc = Problem::not_found().to_json("/a\"b\\c\n");
        let parsed: serde_json::Value = serde_json::from_str(&doc).unwrap();
        assert_eq!(parsed["instance"], "/a\"b\\c\n");
    }

    #[test]
    fn not_migrated_names_the_route() {
        let p = Problem::not_migrated("/[location]/forecast");
        assert_eq!(p.status, 404);
        assert!(p.detail.contains("/[location]/forecast"));
    }
}
