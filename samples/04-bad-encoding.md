# Bad Encoding Fixture

The next line contains bytes that are not valid UTF-8.

Latin-1 degree sign: °  Latin-1 e-acute: é

Lone continuation byte: €

Truncated multi-byte sequence: â‚

Invalid five-byte sequence: øˆ€€€

Overlong encoding of "/": À¯

The upload must be rejected before any of this reaches the database.
