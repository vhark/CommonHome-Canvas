/*
 * CommonHome Canvas - a privacy-first household display and dashboard system.
 * Copyright (C) 2026 CommonHome Canvas contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* Synthetic iCalendar fixtures.
 *
 * EVERY VALUE HERE IS INVENTED. No real address, no real name, no real
 * calendar URL, no household detail. The "leaky" fixture deliberately carries
 * an address-shaped DESCRIPTION so the share-safety test has something real to
 * fail on - it is a made-up street on a made-up road in a made-up town, and
 * example.com is reserved by RFC 2606 precisely for this.
 *
 * Written as string constants rather than .ics files on disk so the test suite
 * stays `node --test src/calendar/` with no fixture-loading machinery, and so
 * the content is visible next to the assertion that depends on it.
 */

/* A weekly RRULE bounded by UNTIL, plus one EXDATE removing an occurrence.
 * The classic household pattern: a club night that skips a week. */
export const WEEKLY_WITH_UNTIL_AND_EXDATE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fixture//Synthetic//EN
X-WR-CALNAME:Fixture Club Calendar
BEGIN:VEVENT
UID:weekly-club@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Pottery Club
DTSTART;VALUE=DATE-TIME;TZID=UTC:20260907T180000Z
DTEND;VALUE=DATE-TIME;TZID=UTC:20260907T193000Z
RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261005T180000Z
EXDATE:20260921T180000Z
END:VEVENT
END:VCALENDAR
`;

/* A recurring series with one instance moved by a RECURRENCE-ID override.
 * The override also changes the SUMMARY, so a test can tell which one won. */
export const SERIES_WITH_OVERRIDE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fixture//Synthetic//EN
BEGIN:VEVENT
UID:standup-series@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Morning Standup
DTSTART:20260907T090000Z
DTEND:20260907T091500Z
RRULE:FREQ=DAILY;COUNT=5
END:VEVENT
BEGIN:VEVENT
UID:standup-series@example.com
DTSTAMP:20260902T120000Z
RECURRENCE-ID:20260909T090000Z
SUMMARY:Morning Standup (moved late)
DTSTART:20260909T140000Z
DTEND:20260909T141500Z
SEQUENCE:1
END:VEVENT
END:VCALENDAR
`;

/* THE ALL-DAY FIXTURE. DTSTART;VALUE=DATE with no time component at all.
 * 2026-09-24 is a Thursday. Treated as midnight UTC, a household in Denver
 * (UTC-6) sees it on the 23rd and a household in Auckland (UTC+12) sees it on
 * the 24th or 25th depending on the hour - which is the bug. */
export const ALL_DAY = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fixture//Synthetic//EN
BEGIN:VEVENT
UID:all-day-bin@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Recycling Collection
DTSTART;VALUE=DATE:20260924
DTEND;VALUE=DATE:20260925
END:VEVENT
END:VCALENDAR
`;

/* A timed event carrying a VTIMEZONE, in the form Google and Nextcloud emit:
 * an IANA TZID plus a full observance block. */
export const TIMED_WITH_VTIMEZONE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fixture//Synthetic//EN
BEGIN:VTIMEZONE
TZID:America/Denver
BEGIN:DAYLIGHT
TZOFFSETFROM:-0700
TZOFFSETTO:-0600
TZNAME:MDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0600
TZOFFSETTO:-0700
TZNAME:MST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:timed-lesson@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Piano Lesson
DTSTART;TZID=America/Denver:20260924T160000
DTEND;TZID=America/Denver:20260924T170000
END:VEVENT
END:VCALENDAR
`;

/* A weekly series that CROSSES A DST BOUNDARY.
 *
 * US DST ends on Sunday 1 November 2026. A weekly 09:00 Monday event starting
 * 26 October must still be at 09:00 local on 2 November - which is only true
 * if the expander does civil arithmetic. Adding 604800000ms gives 08:00. */
export const DST_CROSSING = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fixture//Synthetic//EN
BEGIN:VEVENT
UID:dst-weekly@example.com
DTSTAMP:20261001T120000Z
SUMMARY:Swimming
DTSTART;TZID=America/Denver:20261026T090000
DTEND;TZID=America/Denver:20261026T100000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3
END:VEVENT
END:VCALENDAR
`;

/* THE LEAK FIXTURE. Modelled on the shape of the real finding recorded in
 * calendar-as-canvas.md §2 - a mundane waste-collection calendar whose event
 * descriptions carried a full address, a phone number and a family member's
 * name - but every value below is invented. */
export const LEAKY_PRIVATE_DETAIL = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fixture//Synthetic//EN
X-WR-CALNAME:Fixture Waste Calendar
BEGIN:VEVENT
UID:leaky-bins@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Green Bin Collection
DTSTART;VALUE=DATE:20260925
DTEND;VALUE=DATE:20260926
DESCRIPTION:Route FIXTURE-7 for 123 Imaginary Lane\\, Nowhere Town\\, ZZ1 9ZZ. Confirmed by Fixtureperson. Depot telephone 555-0100.
LOCATION:123 Imaginary Lane\\, Nowhere Town\\, ZZ1 9ZZ
ORGANIZER;CN=Fixture Depot:mailto:depot@example.com
ATTENDEE;CN=Fixtureperson One:mailto:one@example.com
ATTENDEE;CN=Fixtureperson Two:mailto:two@example.com
END:VEVENT
BEGIN:VEVENT
UID:leaky-clinic@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Clinic Appointment
DTSTART:20260925T143000Z
DTEND:20260925T150000Z
DESCRIPTION:Attend 45 Pretend Street\\, Nowhere Town. Ask for Fixture Clinic.
LOCATION:45 Pretend Street\\, Nowhere Town
END:VEVENT
END:VCALENDAR
`;

/* Folded lines, escaped text, quoted parameters containing a colon and a
 * comma, and CRLF endings - the four things a naive parser gets wrong. */
export const AWKWARD_SYNTAX = "BEGIN:VCALENDAR\r\n"
  + "VERSION:2.0\r\n"
  + "PRODID:-//Fixture//Synthetic//EN\r\n"
  + "BEGIN:VEVENT\r\n"
  + "UID:awkward@example.com\r\n"
  + "DTSTAMP:20260901T120000Z\r\n"
  + "SUMMARY:Bring cake\\, candles and a very long description that will be fo\r\n"
  + " lded across lines by the publisher\r\n"
  + "DESCRIPTION:Line one\\nLine two\r\n"
  + "ATTENDEE;CN=\"Fixture, Person\";ROLE=REQ-PARTICIPANT:mailto:person@example.com\r\n"
  + "DTSTART:20260924T100000Z\r\n"
  + "DTEND:20260924T110000Z\r\n"
  + "END:VEVENT\r\n"
  + "END:VCALENDAR\r\n";

/* An RRULE using BYSETPOS: the long tail this expander explicitly declines. */
export const UNSUPPORTED_BYSETPOS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fixture//Synthetic//EN
BEGIN:VEVENT
UID:bysetpos@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Last Weekday Of Month
DTSTART:20260930T170000Z
DTEND:20260930T173000Z
RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1
END:VEVENT
END:VCALENDAR
`;

/* Monthly by ordinal weekday and by negative month day - both SUPPORTED, and
 * both common in household calendars ("first Monday", "last day of month"). */
export const MONTHLY_PATTERNS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fixture//Synthetic//EN
BEGIN:VEVENT
UID:first-monday@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Neighbourhood Meeting
DTSTART:20260907T190000Z
DTEND:20260907T200000Z
RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=4
END:VEVENT
BEGIN:VEVENT
UID:last-day@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Meter Reading
DTSTART:20260930T080000Z
DTEND:20260930T081500Z
RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4
END:VEVENT
END:VCALENDAR
`;

/* A cancelled event and a transparent (free) one: both must be handled, and
 * differently - CANCELLED is a tombstone, TRANSPARENT is merely not busy. */
export const STATUS_AND_TRANSP = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fixture//Synthetic//EN
BEGIN:VEVENT
UID:cancelled@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Cancelled Rehearsal
STATUS:CANCELLED
DTSTART:20260924T180000Z
DTEND:20260924T190000Z
END:VEVENT
BEGIN:VEVENT
UID:transparent@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Public Holiday
STATUS:CONFIRMED
TRANSP:TRANSPARENT
DTSTART;VALUE=DATE:20260924
DTEND;VALUE=DATE:20260925
END:VEVENT
BEGIN:VEVENT
UID:tentative@example.com
DTSTAMP:20260901T120000Z
SUMMARY:Maybe Dinner
STATUS:TENTATIVE
DTSTART:20260924T193000Z
DTEND:20260924T210000Z
END:VEVENT
END:VCALENDAR
`;
