//! Embeddable ratatui terminal pane (feature = "ratatui"). The pane's event
//! pump applies frames directly to the vt100 parser, so an unrendered pane
//! still drains its socket and stays current.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::error::Result;
use crate::frame_codec::TtyResize;
use crate::tty_client::{TtyClient, TtyEvent};

/// [`AttachPane`]'s connection state; meaningful only alongside the pane it
/// came from, so it lives here rather than in its own file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneState {
    Connected,
    Exited { reason: String },
    Disconnected,
}

/// Attaching to an agent is mostly about inspecting what it already did, so
/// the emulator keeps a deep scrollback. vt100 allocates scrollback lazily
/// (an empty `VecDeque` that grows only as lines actually scroll off), so a
/// large cap costs nothing up front.
pub const DEFAULT_SCROLLBACK_LINES: usize = 10_000;

pub struct AttachPane {
    client: TtyClient,
    parser: Arc<Mutex<vt100::Parser>>,
    state: watch::Receiver<PaneState>,
    /// Bumped by the event pump on every applied frame or state change;
    /// awaiting it is the redraw hint.
    generation: watch::Receiver<u64>,
    pump_task: JoinHandle<()>,
}

impl AttachPane {
    /// `scrollback_lines` caps the emulator's history ([`DEFAULT_SCROLLBACK_LINES`]
    /// is a good default); lines beyond the cap are dropped oldest-first.
    pub async fn connect(
        tty_sock: impl AsRef<Path>,
        client_name: &str,
        initial: TtyResize,
        scrollback_lines: usize,
        deadline: Duration,
    ) -> Result<AttachPane> {
        let (mut client, mut events) = TtyClient::connect(tty_sock, client_name, deadline).await?;
        client.resize(initial).await?;
        let parser = Arc::new(Mutex::new(vt100::Parser::new(
            initial.rows,
            initial.cols,
            scrollback_lines,
        )));
        let (state_tx, state) = watch::channel(PaneState::Connected);
        let (generation_tx, generation) = watch::channel(0u64);

        let pump_task = tokio::spawn({
            let parser = Arc::clone(&parser);
            async move {
                while let Some(event) = events.next().await {
                    match event {
                        // Snapshot and output feed one parser in arrival
                        // order; the server guarantees the snapshot precedes
                        // any buffered output.
                        Ok(TtyEvent::Snapshot(bytes)) | Ok(TtyEvent::Output(bytes)) => {
                            parser.lock().unwrap().process(&bytes);
                        }
                        Ok(TtyEvent::Exit { reason }) => {
                            let _ = state_tx.send(PaneState::Exited { reason });
                        }
                        // Protocol errors surface as Disconnected; the frame
                        // stream is unrecoverable past this point.
                        Err(_) => break,
                    }
                    generation_tx.send_modify(|generation| *generation += 1);
                }
                let disconnected = state_tx.send_if_modified(|state| {
                    if *state == PaneState::Connected {
                        *state = PaneState::Disconnected;
                        true
                    } else {
                        false
                    }
                });
                if disconnected {
                    generation_tx.send_modify(|generation| *generation += 1);
                }
            }
        });

        Ok(AttachPane {
            client,
            parser,
            state,
            generation,
            pump_task,
        })
    }

    pub async fn input(&mut self, bytes: &[u8]) -> Result<()> {
        self.client.input(bytes).await
    }

    /// The app calls this when its layout rect changes; rendering never sends
    /// resize (`Widget::render` is sync and pure). Resizes both the server
    /// PTY (min-size across attachers) and the local emulator.
    pub async fn resize(&mut self, size: TtyResize) -> Result<()> {
        self.parser
            .lock()
            .unwrap()
            .screen_mut()
            .set_size(size.rows, size.cols);
        self.client.resize(size).await
    }

    /// Redraw hint: resolves when the screen or state has advanced. After the
    /// pane has stopped (exit or disconnect observed), pends forever, which
    /// keeps `select!` loops from spinning.
    pub async fn changed(&mut self) {
        if self.generation.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }

    /// Scrolls the view `lines` deeper into history, clamped to what the
    /// scrollback actually holds. While scrolled back, vt100 pins the view to
    /// the same content as new output arrives.
    pub fn scroll_up(&mut self, lines: usize) {
        let mut parser = self.parser.lock().unwrap();
        let screen = parser.screen_mut();
        let offset = screen.scrollback();
        screen.set_scrollback(offset.saturating_add(lines));
    }

    /// Scrolls the view `lines` back toward live output; at 0 the pane
    /// follows new output again.
    pub fn scroll_down(&mut self, lines: usize) {
        let mut parser = self.parser.lock().unwrap();
        let screen = parser.screen_mut();
        let offset = screen.scrollback();
        screen.set_scrollback(offset.saturating_sub(lines));
    }

    pub fn state(&self) -> PaneState {
        self.state.borrow().clone()
    }

    pub fn with_screen<R>(&self, f: impl FnOnce(&vt100::Screen) -> R) -> R {
        f(self.parser.lock().unwrap().screen())
    }
}

impl Drop for AttachPane {
    fn drop(&mut self) {
        self.pump_task.abort();
    }
}

impl ratatui::widgets::Widget for &AttachPane {
    fn render(self, area: ratatui::layout::Rect, buf: &mut ratatui::buffer::Buffer) {
        let parser = self.parser.lock().unwrap();
        let pseudo_term = tui_term::widget::PseudoTerminal::new(parser.screen());
        ratatui::widgets::Widget::render(pseudo_term, area, buf);
    }
}

#[cfg(test)]
mod tests;
