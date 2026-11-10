#!/usr/bin/env ruby

require "json"
require "rbconfig"
require "rubygems"

gemfile = ENV["BUNDLE_GEMFILE"]
if gemfile
  require "bundler/setup"
end
require "prism"

class RubyCallDocument
  def initialize(source)
    @source = source
    @methods = []
    @calls = []
    @utf16_offsets = Array.new(source.bytesize + 1, 0)
    @line_starts = [0]
    byte_offset = 0
    utf16_offset = 0

    source.each_char do |character|
      byte_offset += character.bytesize
      utf16_offset += character.ord > 0xffff ? 2 : 1
      @utf16_offsets[byte_offset] = utf16_offset
      @line_starts << byte_offset if character == "\n"
    end
  end

  def parse(uri)
    result = Prism.parse(@source)
    unless result.errors.empty?
      details = result.errors.map(&:message).join("; ")
      raise ArgumentError, "cannot parse #{uri}: #{details}"
    end

    visit(result.value, nil)
    { uri: uri, methods: @methods, calls: @calls }
  end

  private

  def visit(node, owner)
    case node
    when Prism::DefNode
      method_owner = @methods.length
      @methods << {
        name: node.name.to_s,
        range: range(node.location),
        selectionRange: range(node.name_loc)
      }
      node.compact_child_nodes.each do |child|
        child_owner = child.equal?(node.receiver) ? owner : method_owner
        visit(child, child_owner)
      end
    when Prism::ClassNode, Prism::ModuleNode, Prism::SingletonClassNode
      node.compact_child_nodes.each { |child| visit(child, nil) }
    when Prism::CallNode
      call_location = node.message_loc || node.call_operator_loc || node.location
      @calls << { name: node.name.to_s, range: range(call_location), owner: owner, attributeWrite: node.attribute_write? }
      node.compact_child_nodes.each { |child| visit(child, owner) }
    when Prism::SuperNode
      name = owner.nil? ? "super" : @methods[owner][:name]
      @calls << { name: name, range: range(node.keyword_loc), owner: owner, attributeWrite: false }
      node.compact_child_nodes.each { |child| visit(child, owner) }
    when Prism::ForwardingSuperNode
      name = owner.nil? ? "super" : @methods[owner][:name]
      @calls << { name: name, range: range(node.location.copy(length: 5)), owner: owner, attributeWrite: false }
      node.compact_child_nodes.each { |child| visit(child, owner) }
    else
      node.compact_child_nodes.each { |child| visit(child, owner) }
    end
  end

  def range(location)
    { start: position(location.start_offset), end: position(location.end_offset) }
  end

  def position(byte_offset)
    following_line = @line_starts.bsearch_index { |line_start| line_start > byte_offset }
    line = following_line ? following_line - 1 : @line_starts.length - 1
    line_start = @line_starts[line]
    { line: line, character: @utf16_offsets[byte_offset] - @utf16_offsets[line_start] }
  end
end

def request_files(request)
  files = request["files"]
  raise ArgumentError, "parse action requires a files array" unless files.is_a?(Array)

  files.map.with_index do |file, index|
    unless file.is_a?(Hash) && file["uri"].is_a?(String) && file["source"].is_a?(String)
      raise ArgumentError, "files[#{index}] requires string uri and source fields"
    end
    file
  end
end

def ruby_sources(root)
  return [] unless root && File.directory?(root)

  Dir.glob(File.join(root, "**", "*.rb"), File::FNM_DOTMATCH)
    .select { |path| File.file?(path) }
    .map { |path| File.expand_path(path) }
end

def dependency_paths
  specs = if ENV["BUNDLE_GEMFILE"]
    require "bundler"
    Bundler.load.specs
  else
    Gem.loaded_specs.values
  end

  roots = specs.flat_map(&:full_require_paths)
  roots << RbConfig::CONFIG["rubylibdir"]
  roots.flat_map { |root| ruby_sources(root) }.uniq.sort
end

begin
  STDIN.binmode
  STDOUT.binmode
  request = JSON.parse(STDIN.read.force_encoding(Encoding::UTF_8))
  raise ArgumentError, "request must be a JSON object" unless request.is_a?(Hash)

  response = case request["action"]
  when "parse"
    documents = request_files(request).map do |file|
      RubyCallDocument.new(file["source"]).parse(file["uri"])
    end
    { documents: documents }
  when "dependencies"
    { paths: dependency_paths }
  else
    raise ArgumentError, "action must be parse or dependencies"
  end

  STDOUT.write(JSON.generate(response).encode(Encoding::UTF_8))
  STDOUT.write("\n".encode(Encoding::UTF_8))
rescue StandardError, ScriptError => error
  warn "ruby-calls: #{error.class}: #{error.message}"
  exit 1
end
