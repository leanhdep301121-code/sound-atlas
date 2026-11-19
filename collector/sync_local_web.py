"""Copy the deployed website's dist files into the standalone local receiver."""
import argparse
from pathlib import Path
import shutil


def sync(source, target):
    source, target = Path(source).resolve(), Path(target).resolve()
    if not (source / 'collect/index.html').is_file() or not (source / 'styles.css').is_file():
        raise ValueError('Expected the Sound Atlas dist directory')
    shutil.copytree(source, target, dirs_exist_ok=True)
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', help='Website dist directory')
    args = parser.parse_args()
    print(sync(args.source, Path(__file__).parent / 'web'))
