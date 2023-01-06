import logging
import os
import signal
import subprocess
import sys
from typing import List

import psutil

import phoenix.config as config

logger = logging.getLogger(__name__)


class Service:
    """Interface for phoenix services.
    All services must define a ``command`` property.
    """

    working_dir = "."

    def __init__(self) -> None:
        self.child = self.start()

    @property
    def command(self) -> List[str]:
        raise NotImplementedError(f"{type(self)} must define `command`")

    def start(self) -> psutil.Popen:
        """Starts the service."""

        if len(os.listdir(config.get_pids_path())) > 0:
            # Currently, only one instance of Phoenix can be running at any given time.
            # Support for multiple concurrently running instances may be supported in the future.
            logger.warning(
                "Existing running Phoenix instance detected! Shutting "
                "it down and starting a new instance..."
            )
            Service.stop_any()

        return psutil.Popen(
            self.command,
            cwd=self.working_dir,
            stdin=subprocess.PIPE,
            env={**os.environ},
        )

    def stop(self) -> None:
        """Gracefully stops the service."""
        self.child.stdin.close()
        try:
            self.child.wait(timeout=5)
        except psutil.TimeoutExpired:
            self.child.terminate()

    @staticmethod
    def stop_any() -> None:
        """Stops any running instance of the service, whether the instance is being run
        within the current session or if it is being run in a separate process on the
        same host machine. In either case, the instance will be forcibly stopped.
        """
        pids_path = config.get_pids_path()
        for filename in os.listdir(pids_path):
            os.kill(int(filename), signal.SIGKILL)
            filename_path = os.path.join(pids_path, filename)
            os.unlink(filename_path)


class AppService(Service):
    """Service that controls the phoenix application."""

    working_dir = config.server_dir

    def __init__(self, port: int, primary_dataset_name: str, reference_dataset_name: str):
        self.port = port
        self.__primary_dataset_name = primary_dataset_name
        self.__reference_dataset_name = reference_dataset_name
        super().__init__()

    @property
    def command(self) -> List[str]:

        command = [
            sys.executable,
            "main.py",
            "--port",
            str(self.port),
            "--primary",
            str(self.__primary_dataset_name),
            "--reference",
            str(self.__reference_dataset_name),
        ]
        logger.info(f"command: {command}")
        return command
