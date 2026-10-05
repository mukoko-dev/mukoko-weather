//! Personal-data check, run before any model call.
//!
//! Shamwari's rule is that personal content never reaches cloud inference, so
//! a message carrying an email address, a phone number or a payment card
//! number is refused (`422 personal_data_detected`), as the Nyuchi API does
//! for Nyuchi AI. The check errs towards refusing; weather talk (temperatures,
//! dates, times, coordinates) does not trip it.

/// Whether `text` carries an email address, a phone number or a card number.
pub fn contains_personal_data(text: &str) -> bool {
    has_email(text) || has_long_number(text)
}

fn has_email(text: &str) -> bool {
    let local_ok = |c: char| c.is_ascii_alphanumeric() || "._%+-".contains(c);
    let domain_ok = |c: char| c.is_ascii_alphanumeric() || ".-".contains(c);
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c != '@' {
            continue;
        }
        let local = chars[..i]
            .iter()
            .rev()
            .take_while(|c| local_ok(**c))
            .count();
        let domain: String = chars[i + 1..]
            .iter()
            .take_while(|c| domain_ok(**c))
            .collect();
        let domain = domain.trim_end_matches('.');
        if local > 0 {
            if let Some((name, tld)) = domain.rsplit_once('.') {
                if !name.is_empty()
                    && tld.len() >= 2
                    && tld.chars().all(|c| c.is_ascii_alphabetic())
                {
                    return true;
                }
            }
        }
    }
    false
}

/// A run of 9 or more digits, allowing the separators people type inside
/// phone and card numbers (spaces, `-`, `.`, `(`, `)`) and a leading `+`.
/// That covers phone numbers (`+263 77 123 4567`, `0771234567`) and card
/// numbers, and leaves dates (`2026-10-05`, 8 digits), times and readings.
fn has_long_number(text: &str) -> bool {
    let mut digits = 0usize;
    let mut pending_sep = 0usize;
    for c in text.chars() {
        if c.is_ascii_digit() {
            digits += 1;
            pending_sep = 0;
            if digits >= 9 {
                return true;
            }
        } else if " -.()".contains(c) && digits > 0 && pending_sep < 2 {
            // Up to two separators between digit groups keep the run going
            // (`(077) 123`); three in a row (`05 - 07`) end it.
            pending_sep += 1;
        } else if c == '+' && digits == 0 {
            // A leading `+` starts a run.
        } else {
            digits = 0;
            pending_sep = 0;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_emails() {
        assert!(contains_personal_data(
            "write to tendai@example.co.zw please"
        ));
        assert!(contains_personal_data("x.y+z@mail.com"));
        assert!(!contains_personal_data("meet @ 5pm"));
        assert!(!contains_personal_data("@harare weather"));
        assert!(!contains_personal_data("a@b"));
    }

    #[test]
    fn finds_phone_and_card_numbers() {
        assert!(contains_personal_data("call +263 77 123 4567"));
        assert!(contains_personal_data("my number is 0771234567"));
        assert!(contains_personal_data("(077) 123-4567"));
        assert!(contains_personal_data("card 4111 1111 1111 1111"));
    }

    #[test]
    fn leaves_weather_talk_alone() {
        for ok in [
            "Will it rain in Harare on 2026-10-05?",
            "It was 31.5 degrees at 14:30",
            "lat -17.83, lon 31.05",
            "Compare 2024 and 2025 rainfall",
            "between 10 and 20 mm",
            "1013.25 hPa",
            "2026-10-05 - 2026-10-07",
        ] {
            assert!(!contains_personal_data(ok), "{ok}");
        }
    }
}
