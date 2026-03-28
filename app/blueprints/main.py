from flask import Blueprint, abort, render_template

main_bp = Blueprint("main", __name__)


@main_bp.route("/", defaults={"path": ""})
@main_bp.route("/<path:path>")
def shell(path: str):
    if path == "api" or path.startswith("api/"):
        abort(404)
    return render_template("index.html")
