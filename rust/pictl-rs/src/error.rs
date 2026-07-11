#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// Framing violations, bad socket hello.
    #[error("protocol error: {0}")]
    Protocol(String),
    /// A `pictl` invocation exited nonzero (other than `wait` timeout).
    #[error("pictl {args:?} failed with status {status:?}: {stderr}")]
    Cli {
        args: Vec<String>,
        status: Option<i32>,
        stderr: String,
    },
    /// An RPC response with `success: false`.
    #[error("rpc error: {0}")]
    Rpc(String),
    /// `pictl wait` timed out (exit code 3).
    #[error("timed out")]
    Timeout,
    /// Socket closed mid-operation.
    #[error("connection closed")]
    Closed,
}

pub type Result<T> = std::result::Result<T, Error>;
