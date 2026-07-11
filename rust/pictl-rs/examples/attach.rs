//! Attach to a pictl agent in a ratatui UI: renders the agent's terminal via
//! [`AttachPane`] with an activity indicator driven by [`ActivityWatcher`],
//! forwards keystrokes, and resizes the pane with the layout.
//!
//! ```sh
//! cargo run --features ratatui --example attach -- <agent-id>
//! ```
//!
//! Ctrl-] detaches; the agent keeps running. PgUp/PgDn scroll the local
//! scrollback (they are not forwarded to the agent); any other key snaps the
//! view back to live output.

// TDC: Let's make this example a bit more interesting. I'd like the default view to list available agents, along with their statuses indicated somehow. The user can use arrow keys (or j/k) to navigate to select one (or ctrl+n to spawn a new one), then ctrl+e to archive or Enter to attach. When attaching, let's make it so that the screen splits vertically, leaving the list of agents on the left, and opening the selected agent in the right pane. Ctrl+] can then be used to switch between panes. If a different agent is selected and attached with Enter, then it "takes over" the right pane, so at most one agent is attached at any given time. Don't do this immediately. Let's resolve and review all the other issues first.

use std::time::Duration;

use crossterm::cursor::Show as ShowCursor;
use crossterm::event::{Event, EventStream, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{LeaveAlternateScreen, disable_raw_mode};
use futures_util::StreamExt;
use pictl_rs::{
    ActivityWatcher, AgentActivity, AttachPane, DEFAULT_SCROLLBACK_LINES, PaneState, Pictl,
    TtyResize,
};
use ratatui::layout::{Constraint, Layout, Size};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::{DefaultTerminal, Frame};
use terminput::Encoding;
use terminput_crossterm::to_terminput;
use tokio::signal::unix::{SignalKind, signal};

const CONNECT_DEADLINE: Duration = Duration::from_secs(5);
const STATUS_LINE_ROWS: u16 = 1;

/// The single terminal-restore path, for both normal exit and panics.
/// `ratatui::restore` (and ratatui's own panic hook) only leaves the
/// alternate screen and disables raw mode — it never shows the cursor, which
/// `Terminal::draw` hides on every frame that sets no cursor position, so
/// this does all three. Best-effort: the sequences are idempotent, and
/// overlapping with ratatui's panic-hook restore is harmless.
fn restore_terminal() {
    let _ = execute!(std::io::stdout(), LeaveAlternateScreen, ShowCursor);
    let _ = disable_raw_mode();
}

/// Chains a terminal restore in front of the current panic hook (ratatui's,
/// once `ratatui::init` has run), so a panic message lands on a usable screen.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        previous(info);
    }));
}

#[tokio::main]
async fn main() {
    let Some(target) = std::env::args().nth(1) else {
        eprintln!("usage: attach <agent-id>");
        std::process::exit(2);
    };
    let mut terminal = ratatui::init();
    install_panic_hook();
    let result = run(&mut terminal, &target).await;
    restore_terminal();
    if let Err(err) = result {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn pane_size(terminal: Size) -> TtyResize {
    TtyResize {
        cols: terminal.width,
        rows: terminal.height.saturating_sub(STATUS_LINE_ROWS).max(1),
    }
}

/// Ctrl+] reads as `Char(']')` only on kitty-protocol terminals; legacy
/// terminals send the bare byte 0x1D, which is ambiguous (Ctrl+5 produces it
/// too) and which crossterm reports as Ctrl+'5'. Accept both, so Ctrl+5 also
/// detaches on legacy terminals.
fn is_detach(key: &crossterm::event::KeyEvent) -> bool {
    matches!(key.code, KeyCode::Char(']') | KeyCode::Char('5'))
        && key.modifiers.contains(KeyModifiers::CONTROL)
}

/// Terminal byte encoding of a key event (legacy xterm protocol, what a PTY
/// expects), via terminput. Unsupported keys encode to nothing and are
/// dropped.
fn encode_key(key: crossterm::event::KeyEvent) -> Option<Vec<u8>> {
    let event = to_terminput(Event::Key(key)).ok()?;
    let mut buf = [0u8; 16];
    let written = event.encode(&mut buf, Encoding::Xterm).ok()?;
    Some(buf[..written].to_vec())
}

async fn run(
    terminal: &mut DefaultTerminal,
    target: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let probes = Pictl::new().status(&[target]).await?;
    let probe = probes.first().ok_or("no agent matched")?;
    let record = probe
        .record
        .as_ref()
        .ok_or_else(|| format!("agent is {:?} and has no record", probe.status))?;

    let mut size = pane_size(terminal.size()?);
    let mut pane = AttachPane::connect(
        record.tty_socket_path(),
        "pictl-rs attach example",
        size,
        DEFAULT_SCROLLBACK_LINES,
        CONNECT_DEADLINE,
    )
    .await?;
    let mut watcher = ActivityWatcher::connect(record.pi_socket_path(), CONNECT_DEADLINE).await?;
    let mut input = EventStream::new();
    // In raw mode Ctrl+C is just a key event (forwarded to the agent), but
    // external kills should still exit through the terminal-restoring path.
    let mut sigint = signal(SignalKind::interrupt())?;
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sighup = signal(SignalKind::hangup())?;

    terminal.draw(|frame| draw(frame, &pane, watcher.current()))?;
    loop {
        // Drain-before-draw: block until one event arrives, keep handling
        // while more are ready, and redraw only when the guarded arm (last
        // under `biased`) finds nothing else pending. Redrawing per event
        // would flicker under bursty output.
        let mut something_happened = false;
        loop {
            tokio::select! {
                biased;
                _ = sigint.recv() => return Ok(()),
                _ = sigterm.recv() => return Ok(()),
                _ = sighup.recv() => return Ok(()),
                event = input.next() => match event.ok_or("input stream ended")?? {
                    Event::Key(key) if key.kind != KeyEventKind::Release => {
                        let page = usize::from(size.rows.saturating_sub(10).max(1));
                        if is_detach(&key) {
                            return Ok(());
                        } else if key.code == KeyCode::PageUp {
                            pane.scroll_up(page);
                        } else if key.code == KeyCode::PageDown {
                            pane.scroll_down(page);
                        } else if let Some(bytes) = encode_key(key) {
                            // Typing while scrolled back would be invisible;
                            // snap to live output first.
                            pane.scroll_down(usize::MAX);
                            pane.input(&bytes).await?;
                        }
                    }
                    Event::Resize(cols, rows) => {
                        size = pane_size(Size::new(cols, rows));
                        pane.resize(size).await?;
                    }
                    _ => {}
                },
                _ = pane.changed() => {}
                _ = watcher.changed() => {}
                _ = async {}, if something_happened => break,
            }
            something_happened = true;
        }
        terminal.draw(|frame| draw(frame, &pane, watcher.current()))?;
    }
}

fn draw(frame: &mut Frame, pane: &AttachPane, activity: AgentActivity) {
    let [status_area, pane_area] =
        Layout::vertical([Constraint::Length(STATUS_LINE_ROWS), Constraint::Min(0)])
            .areas(frame.area());

    let (indicator, color) = match activity {
        AgentActivity::Streaming => ("● Streaming", Color::Green),
        AgentActivity::Compacting => ("♻ Compacting", Color::Yellow),
        AgentActivity::Idle => ("○ Idle", Color::DarkGray),
        AgentActivity::Disconnected => ("✕ Disconnected", Color::Red),
    };
    let mut status = vec![Span::styled(indicator, Style::default().fg(color))];
    match pane.state() {
        PaneState::Connected => {}
        PaneState::Exited { reason } => {
            status.push(Span::styled(
                format!("  [agent exited: {reason}]"),
                Style::default().fg(Color::Red),
            ));
        }
        PaneState::Disconnected => {
            status.push(Span::styled(
                "  [tty disconnected]",
                Style::default().fg(Color::Red),
            ));
        }
    }
    let scrollback = pane.with_screen(|screen| screen.scrollback());
    if scrollback > 0 {
        status.push(Span::styled(
            format!("  [scrollback {scrollback}]"),
            Style::default().fg(Color::Yellow),
        ));
    }
    status.push(Span::styled(
        "  Ctrl-] to detach",
        Style::default().fg(Color::DarkGray),
    ));
    frame.render_widget(Line::from(status), status_area);
    frame.render_widget(pane, pane_area);
}
