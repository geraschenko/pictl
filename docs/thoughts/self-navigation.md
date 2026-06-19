During the metacognition discussion, it turned out that self-navigation doesn't work because the command
pictl -t $PICTL_AGENT_ID navigate-tree
that the agent has to run puts it in a streaming state, which causes navigateTree to error. Gotta fix that.