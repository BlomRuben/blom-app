"""Fouten die de server als nette melding aan de app teruggeeft."""


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
