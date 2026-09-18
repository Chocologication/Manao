package com.manao.poc4.log;

import java.util.Optional;

/** Single-use ticket consumption boundary used by WebSocket handshakes. */
public interface LogTicketAuthenticator {
    Optional<LogTicketService.TicketRecord> consume(String ticket);
}
