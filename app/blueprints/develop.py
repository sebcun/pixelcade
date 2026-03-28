from flask import Blueprint

develop_bp = Blueprint("develop", __name__)


@develop_bp.route("/")
def index():
    return "develop portal placeholder"
