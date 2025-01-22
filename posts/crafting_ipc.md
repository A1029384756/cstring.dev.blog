---
title: IPC From Scratch
date: '2025-01-19T00:00:00.000Z'
author: Hayden Gray
draft: false
tags:
  - Odin
  - Programming
comments: {}
---

Inter-process communication (or IPC) doesn't typically cause 
programmers to feel warm fuzzies. "Wait, I just want my programs
to talk to each other, why is this hard???" is a sentiment that
I very much understand. Recently
when working on [Mixologist](https://github.com/A1029384756/mixologist)
I came to a point where I needed a CLI, a GUI, and a daemon to
all run and communicate with one another, sending info back in
forth in a wonderfully **concurrent**, **unordered** fashion. Those two
words being used together usually send shivers down the spine of any 
experienced programmer but, with a little legwork, the problem
**is** solveable.
<!--more-->

## Humble Beginnings
Let's go back to the beginning; I started my work on Mixologists
IPC requiring only a daemon and a CLI. This allowed me to dip my
toes into the waters of IPC without having to go straight into the deep end.
After doing some cursory research, I had a few options to pursue:
- Shared Memory
- Pipes
- Sockets

Initially, shared memory looked decently promising since it would 
give me full access to the shdared state of each process from any of the 
others but I ultimately decided against it simply because of the
synchronization headache and the difficulty around creating
custom clients to interact with my program. Pipes were also a no-go
unfortunately because I expected to need bidirectional communication.
This left me with sockets, probably one of the most common tools for
IPC both due to their flexibility and relative ease of use.

So how do you make a socket?
```odin
sock_fd, sock_err := linux.socket(.UNIX, .STREAM, {}, .HOPOPT)
```

Well that isn't too bad.

Unfortunately, there is some extra work to do depending on if
you're the server or the client. If you're the server, the setup
is as follows:
```odin
sock_fd, sock_err := linux.socket(.UNIX, .STREAM, {}, .HOPOPT)

sock_addr: linux.Sock_Addr_Un,
sock_addr.sun_family = .UNIX
copy(sock_addr.sun_path[:], "/tmp/socket_name")

bind_err := linux.bind(sock_fd, &sock_addr)
listen_err := linux.listen(sock_fd, 1024)
```

So what did that do? Well, we start by initially setting up the
socket and its address, just giving it a name on the filesystem
to use. We then `bind` the socket which is what actually sets
up the socket on the system. Finally, we `listen` on the socket
which allows us to accept incoming connections.

The client side is simpler:
```odin
sock_fd, sock_err := linux.socket(.UNIX, .STREAM, {}, .HOPOPT)

sock_addr: linux.Sock_Addr_Un,
sock_addr.sun_family = .UNIX
copy(sock_addr.sun_path[:], "/tmp/socket_name")

connect_err := linux.connect(sock_fd, &sock_addr)
```

The setup is the same as for the server but instead of `bind` and
`listen`, we just `connect`. This can of course error (the socket
may not exist) but that is something we can handle on the caller side.

Some of you may have noticed that I'm using `.UNIX` and `.STREAM` for
the socket type and are asking "what's that all about?" We are making
use of [Unix domain sockets](https://en.wikipedia.org/wiki/Unix_domain_socket)
here instead of INET sockets since they are targeted towards local
use. We are also making use of **stream** sockets instead of **datagram**
sockets because knowing about the **connection** itself is important.

> Datagram sockets can be extremely useful when you rely on clearly
> defined package boundaries and don't require an order. They don't
> have the concept of a "connection" however which can make certain
> things harder to write.

## Unidirectional Communication
Let's look at the interface for the CLI I built:
```
Flags:
	-add-program:<string>, multiple     | name of program to add to aux
	-remove-program:<string>, multiple  | name of program to remove from aux
	-set-volume:<f32>                   | volume to assign nodes
	-shift-volume:<f32>                 | volume to increment nodes
```

So, as it stands, the cli only needs to send things to the daemon.
That makes it so that we only ever need to call `send` on the client 
to get the data sent over to the server which is relatively simple:
```odin
bytes_sent, send_err := linux.send(sock_fd, message, {})
```

On the server side, we do the following:
```odin
buf: [1024]u8

// event loop
for {
    client_fd, client_err := linux.accept(sock_fd, &sock_addr, {})
    bytes_read, recv_err := linux.recv(client_fd, buf[:], {})

    // handle message
    // other event loop stuff
}
```

This is pretty simple but the minute we try and run the program, we'll
notice that the event loop just... stalls. The reason that happens is
because the socket is *blocking*. That means that whenever we call `recv`
on the socket, program execution will halt until the socket recieves some
data. So how do we solve this? Well fortunately, when you create a socket,
you can add a single flag, changing the instantiation to this:
```odin
sock_fd, sock_err := linux.socket(.UNIX, .STREAM, {.NONBLOCK}, .HOPOPT)
```

Now when we call recv, we can check `recv_err` to see if it is either
`EWOULDBLOCK` or `EAGAIN` and if so, skip any subsequent code that would
depend on the result of a finished transmission.

> Checking both is something you should do for portability reasons.
> Unfortunately, you can't assume that these error codes are the
> same value.

With that change in place, we can now run any of our commands (i.e.
`mixcli -set-volume:0`) and hear (this is an audio program after all)
the results in real-time. Unfortunately, although we do have data 
going to the daemon, we don't have anything coming back. That's a
bit of an issue if we want to add something like `-get-volume` 
which could be good for scripts and other tools.

## Bidirectional Communication
So how might we add that? Well, on the client we can do this:
```odin
bytes_sent, send_err := linux.send(sock_fd, message, {})
buf: [1024]u8
bytes_recv, recv_err := linux.recv(sock_fd, buf[:], {})
```

On something like the CLI, we actually *don't* want the socket to be
blocking. Instead, we can use a normal non-blocking socket and just have
`recv` block until we get a response from the daemon.

On the daemon side, we can do some simple message processing and then
craft a response to send back to the CLI:
```odin
buf: [1024]u8
for {
    client_fd, client_err := linux.accept(sock_fd, &sock_addr, {})
    bytes_read, recv_err := linux.recv(client_fd, buf[:], {})

    // process input

    // send reponse
    bytes_sent, send_err := linux.send(client_fd, response, {})

    // other event loop stuff
}
```

Now, when we run our program:
```
mixcli -get-volume
0.2
```
we get the expected response.

## The N+1 Problem
With a CLI working, it's time to add a GUI. Let's start by roughing out
the GUI with no actual backend plumbing:

<img src="/assets/crafting_ipc/mixgui.png" />

So, what data is needed by the program? Well, the list of program rules that
should populate the text box list and the volume assigned to `mixd` itself is needed.
This however, will be handled by `inotify` watching the config for the time being.
We also want changes to the volume slider (bottom) though. These changes should of
course be sent to `mixd` but we also want changes made to the volume by other programs
(i.e. `mixcli` or another GUI instance) to show up here. That means that we
probably need a way to "subscribe" to changes to the volume. That means we
will need:
- Managing of multiple simultaneous connections
- Persistent connections
- A way to handle disconnected clients
- Tracking of "subscribers"

In a [previous](/posts/hijacking_pipewire_for_fun_and_profit.md#mixcli) post, I
mentioned the basic message-passing format I was using to send data from the
client to the CLI. We will make a couple changes here though:
```odin
Message :: union {
	Volume,
	Program,
}

Volume :: struct {
	act: enum {
		Set,
		Shift,
        // these are new
		Get,
		Subscribe,
	},
	val: f32,
}

Program :: struct {
	act: enum {
		Add,
		Remove,
	},
	val: string,
}
```

> Note: we use CBOR to encode the message as it is trivially serialized,
> has a relatively low size, and is quite resilient to format changes.

So, these `Get` and `Subscribe` messages will allow us as users
to make a request to the server telling it that we want all future
updates to the volume. On the client, this is relatively simple:
```odin
msg := common.Volume {
    .Subscribe,
    0,
}

cbor_msg, _ := cbor.marshal(msg)
defer delete(cbor_msg)

bytes_sent, send_err := linux.send(client_fd, cbor_msg, {})
```

On the server however, we have an issue now: our current
implementation only allows for a single connected client.
That means if we want to keep the connection open to send
data back to the client, we'll need to have a way of managing
multiple sockets at once.

## Enter `poll()`
Fortunately, there are tools that exist to deal with many sockets
but there are two that I considered in this case:
- poll
- epoll

Although `epoll` was attractive because of it's better asymptotic
performance, I decided against it for two reasons:
- More complex to set up
- Low number of sockets

So, on the server, we can start creating an IPC system, here's the
state for it:
```odin
IPC_Server_Context :: struct {
	server_fd:            linux.Fd,
	server_addr:          linux.Sock_Addr_Un,
	_clients:             sa.Small_Array(MAX_CLIENTS, linux.Poll_Fd),
	_removed_clients:     sa.Small_Array(MAX_CLIENTS, linux.Fd),
	_buf:                 [BUF_SIZE]u8,
}
```

We then initialize it like so:
```odin
IPC_Server_init :: proc(ctx: ^IPC_Server_Context) -> linux.Errno {
    // this allows us to handle disconnects that aren't graceful
	posix.signal(.SIGPIPE, IPC_Server__handle_sigpipe)

	sock_err: linux.Errno
	ctx.server_fd, sock_err = linux.socket(
        .UNIX,
        .STREAM,
        {.NONBLOCK},
        .HOPOPT
    )
	if sock_err != nil {
        log.panicf("could not create socket with error %v", sock_err)
    }

	ctx.server_addr.sun_family = .UNIX
	copy(ctx.server_addr.sun_path[:], SERVER_SOCKET)

    // unlink the socket in the case of an unclean exit
	linux.unlink(SERVER_SOCKET)
	linux.bind(ctx.server_fd, &ctx.server_addr) or_return
	listen_err := linux.listen(ctx.server_fd, 1024)

    // set up a Poll_Fd to trigger when the server accepts connections
	sa.append(&ctx._clients, linux.Poll_Fd{fd = ctx.server_fd, events = {.IN}})
	return listen_err
}
```

> `core:containers/small_array` is really nice here since it gives us
> dynamic array semantics on a fixed size array, allowing us to stack
> allocate it.

With our basic server set up, we can now run the following code every
cycle of the event loop:
```odin
_, poll_err := linux.poll(sa.slice(&ctx._clients), 5)
if poll_err != nil && mixd_ctx.should_exit do return
else if poll_err != nil do log.panicf("poll error: %v", poll_err)

if sa.get(ctx._clients, 0).revents >= {.IN} {
	client_fd, client_err := linux.accept(
        ctx.server_fd,
        &ctx.server_addr,
        {.NONBLOCK}
    )
	if client_err != nil do log.panicf("accept error %v", client_err)
	log.debugf("client connected: socket %v", client_fd)
	sa.append(&ctx._clients, linux.Poll_Fd{fd = client_fd, events = {.IN}})
}
```

In this case, we `poll()` all active clients and also check if we
are able to `accept()` on the server socket. If a new connection is
active, we add it to the list of clients. We can then iterate over the
list of clients and call `read()` on them. In practice, the result looks like 
this:
```odin
#reverse for &client, idx in sa.slice(&ctx._clients)[1:] {
	if client.revents >= {.IN} {
		bytes_read, read_err := linux.read(client.fd, ctx._buf[:])
		if read_err == .EWOULDBLOCK || read_err == .EAGAIN do continue
        // process message here
    }
}
```
> `#reverse` is a surprise tool that will help us later

## Subscriptions
Since we now have the option to handle multiple sockets concurrently,
how do we handle subscriptions? Well, we can add the following field
to our context struct:
```odin
_volume_subscribers:  sa.Small_Array(MAX_CLIENTS, linux.Fd)
```
This is just a simple list that we can use to keep track of all
of our volume subscribers. If we recieve a subscribe message, we
just add the subscriber to the list of potential subscribers:
```odin
// other cases should also be handled for msg and act
switch msg in msg {
case common.Volume:
	switch msg.act {
	case .Subscribe:
	    _, found := slice.linear_search(
            sa.slice(&ctx._volume_subscribers),
            client_fd
        )
	    if !found do sa.append(&ctx._volume_subscribers, client_fd)
    }
}
```

Now, when we update the volume, we can just send a message out to each
subscriber:
```odin
msg := common.Volume{.Get, mixd_ctx.vol}
for client_fd in sa.slice(&ctx._volume_subscribers) {
    // wrapping this commonly used stuff into procs
    IPC_Server_send(ctx, client_fd, msg)
}
```

This is all well and good but as it stands, we still don't know when
a client has disconnected or how we should manage that. Well, fortunately
with `poll()` we can just check if reading from the socket returns
zero bytes and remove it from the connections list.
```odin
if bytes_read == 0 {
	sa.unordered_remove(&ctx._clients, idx + 1)
	sa.append(&ctx._removed_clients, client.fd)
}
```

> the `#reverse` mentioned earlier allows us to call `unordered_remove` 
> without invalidating the iterator

After processing all the messages, we can also manage
removing all the resources for each removed client:
```odin
for fd in sa.slice(&ctx._removed_clients) {
	IPC_Server_remove_volume_subscriber(ctx, fd)
	linux.close(fd)
}
```

Although we could call it a day here, we might also want to do
some extra work, most notably around handling if the socket
has not gracefully been closed. Fortunately, this is just
another `if`:
```odin
if read_err != nil {
	sa.unordered_remove(&ctx._clients, idx + 1)
	sa.append(&ctx._removed_clients, client.fd)
}
```

## Abstract Sockets
Before we finish up, there is a final concept that is extremely
nice to have when using Unix domain sockets on Linux: abstract
sockets. These are a non-portable, Linux-only extension that
can be accessed by having the first byte of the socket path be
NUL. This makes it so that the socket has no connection to
filesystem pathnames and will automatically disappear when all
references to the socket are closed (although there does seem
to be a timer on this).

## Putting it All Together
So what does this leave us with? Well, we effectively
have ended up with a single-threaded server that is tailored
to handling a custom format that we created. Being single-threaded
allows us to avoid having to use synchronization primitives while
the limited number of potential clients prevents this from becoming
an issue.

So to summarize, on the server:
- Make a server struct to track the following
    - Active sockets
    - Sockets to remove
    - Subscriptions
- Create a nonblocking socket
- Add the socket to the list of active sockets
- Poll list of active sockets and process their events
- Clean up sockets that are no longer connected

on a client like a GUI:
- Open a socket
- Send a "Subscribe" message
- Recieve all future events
- Send all updates to the client

and on a client like a CLI:
- Open a socket
- Send message
- Listen for response if applicable

A more complete implementation can be found in the
[Mixologist](https://github.com/A1029384756/mixologist)
repo if more examples are needed.

So, hopefully this helped you if you made it this far. Thanks
for reading and have a great day!
