"""Upload the Maix runtime over SSH without replacing the board launcher."""

import argparse
import getpass
import posixpath
from pathlib import Path


EXCLUDED_MODULES = {"__init__.py", "deploy.py"}


def runtime_files(source_dir):
    source = Path(source_dir)
    return sorted(
        (
            path
            for path in source.iterdir()
            if path.is_file()
            and path.suffix == ".py"
            and path.name not in EXCLUDED_MODULES
        ),
        key=lambda path: path.name,
    )


def ensure_remote_dir(sftp, remote_dir):
    parts = []
    current = posixpath.normpath(remote_dir)
    while current not in ("", "/"):
        parts.append(current)
        current = posixpath.dirname(current)
    for directory in reversed(parts):
        try:
            sftp.stat(directory)
        except OSError:
            sftp.mkdir(directory)


def deploy(host, user, password, remote_dir, source_dir=None):
    try:
        import paramiko
    except ImportError as exc:
        raise RuntimeError(
            "Paramiko is required: python -m pip install --user paramiko"
        ) from exc

    source = Path(source_dir or Path(__file__).resolve().parent)
    files = runtime_files(source)
    if not files:
        raise RuntimeError("no Maix runtime files found in {}".format(source))

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        host,
        username=user,
        password=password,
        timeout=8,
        look_for_keys=False,
        allow_agent=False,
    )
    try:
        sftp = client.open_sftp()
        try:
            ensure_remote_dir(sftp, remote_dir)
            for local_path in files:
                remote_path = posixpath.join(remote_dir, local_path.name)
                sftp.put(str(local_path), remote_path)
                print("uploaded {} -> {}".format(local_path.name, remote_path))
        finally:
            sftp.close()

        command = "python -m compileall -q {}".format(remote_dir)
        _, stdout, stderr = client.exec_command(command, timeout=20)
        output = stdout.read().decode("utf-8", "replace")
        error = stderr.read().decode("utf-8", "replace")
        status = stdout.channel.recv_exit_status()
        if output:
            print(output, end="")
        if error:
            print(error, end="")
        if status != 0:
            raise RuntimeError("remote compile failed with code {}".format(status))
    finally:
        client.close()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Deploy PoseGuard to MaixCAM")
    parser.add_argument("--host", default="192.168.31.114")
    parser.add_argument("--user", default="root")
    parser.add_argument("--password")
    parser.add_argument("--remote-dir", default="/root/poseguard_maix")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    password = args.password
    if password is None:
        password = getpass.getpass("SSH password: ")
    deploy(
        args.host,
        args.user,
        password,
        args.remote_dir,
    )
    print("deployment complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
